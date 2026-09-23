/** Runner container cell: owns the Rust runner + tenant celld fleets.
 *
 * One SQLite-backed DO (`RunnerContainer`), singleton (`max_instances: 1`,
 * `instance_type: standard-4` — builds + N tenant fleets + duckdb share one
 * cgroup). The worker reaches the runner API on 8080, the sync API on 18080,
 * and tenant fleets on their listen ports through this DO — Caddy on the
 * compose network can never dial container ports directly, so all edge
 * traffic goes control:8090 → worker Host-dispatch → container port.
 *
 * Disk is ephemeral (move/restart/reset destroys it) and the fence blocks
 * every route to the compose object store, so the runner talks S3-protocol
 * to a loopback sidecar and this DO relays durability into R2 (same fleet
 * bucket, `r2/noite-runner/`, no second store or credential): import on
 * every container start, export on cron. The 5-min relay excludes telemetry
 * spans (bandwidth proportional to state, not spans); the nightly backup
 * copies them to `backup/<date>/` (7-day retention, explicit restore via
 * `/__do/restore`). The metrics watermark persists in the SQLite snapshot,
 * so moves resume aggregation instead of resetting it.
 */

import { Container } from "@cloudflare/containers";
import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";

const RUNNER_PORT = 8080;
const SYNC_PORT = 18_080;
const ROUTES_TTL_MS = 5000;
const MANIFEST_KEY = "runner/manifest.json";
/** Nightly backup retention: dated `backup/<date>/` prefixes kept in R2. */
const BACKUP_RETAIN_DAYS = 7;

const EdgeRouteSchema = Schema.Struct({
  internalPort: Schema.Number,
  listenPort: Schema.Number,
  slug: Schema.String,
  status: Schema.String,
});
type EdgeRoute = Schema.Schema.Type<typeof EdgeRouteSchema>;

const EdgeRoutesPayloadSchema = Schema.Struct({
  routes: Schema.optional(Schema.Array(EdgeRouteSchema)),
});

const HealthPayloadSchema = Schema.Struct({
  busy: Schema.optional(Schema.Boolean),
});

const SyncObjectSchema = Schema.Struct({
  etag: Schema.String,
  key: Schema.String,
  size: Schema.Number,
});
const SyncManifestSchema = Schema.Struct({
  imported: Schema.Boolean,
  objects: Schema.Array(SyncObjectSchema),
});
/** Stored R2 manifest: same object set as the live array form, kept as an
 * etag map for O(1) diffing on export. */
const RelayManifestSchema = Schema.Struct({
  objects: Schema.Record(Schema.String, Schema.String),
});
type RelayManifest = Schema.Schema.Type<typeof RelayManifestSchema>;

interface CachedRoutes {
  at: number;
  bySlug: Record<string, EdgeRoute>;
}

/** Env keys forwarded into the runner container on every start. */
const RUNNER_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "BASE_DOMAIN",
  "CADDYFILE_PATH",
  "CADDY_API_UPSTREAM",
  "CADDY_CONTROL_UPSTREAM",
  "CADDY_UPSTREAM_HOST",
  "CELLD_BIN",
  "CONTROL_EXTRA_HOSTS",
  "CONTROL_SUBDOMAIN",
  "GIT_PUBLIC_BASE",
  "NOITE_S3_BUCKET",
  "PORT_BASE",
  "RUNNER_BIND",
  "RUNNER_POLL_MS",
  "RUNNER_SIDECAR_S3",
  "RUNNER_TOKEN",
  "RUNNER_WORK_DIR",
  "RUSTFS_ACCESS_KEY",
  "RUSTFS_SECRET_KEY",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "UI_URL",
] as const;

interface ContainerEnv {
  RUNNER_SNAP?: R2Bucket;
  [key: string]: R2Bucket | string | undefined;
}

interface PortRoute {
  port: number;
  rest: string;
}

/** Split a `/{port}/...` prefix off a container-bound path. */
const parsePortPrefix = (pathname: string): PortRoute | null => {
  const match = /^\/(?<port>\d{2,5})(?<rest>\/.*)?$/u.exec(pathname);
  if (!match?.groups) {
    return null;
  }
  const port = Number(match.groups.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
    return null;
  }
  return { port, rest: match.groups.rest ?? "/" };
};
export class RunnerContainer extends Container<ContainerEnv> {
  private readonly doCtx: DurableObjectState;
  private readonly doEnv: ContainerEnv;
  private needsImport = true;
  private importFlight: Promise<void> | null = null;
  override defaultPort = RUNNER_PORT;
  override sleepAfter = "10m";

  /** Static fallback env (per-start overrides come from worker env/secrets). */
  override envVars = {
    RUNNER_BIND: "0.0.0.0:8080",
  };

  constructor(ctx: DurableObjectState, env: ContainerEnv) {
    super(ctx, env);
    this.doCtx = ctx;
    this.doEnv = env;
  }

  override onStart(): void {
    // Fresh disk on every start: the next non-sync fetch imports the relay.
    this.needsImport = true;
    this.importFlight = null;
    console.log("runner container started");
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- Container lifecycle hook; no instance state needed beyond the log.
  override onStop(): void {
    console.log("runner container stopped");
  }

  // oxlint-disable-next-line eslint/class-methods-use-this, anti-slop/no-unknown-parameters -- Container base signature fixes `unknown` (only logged) and hooks need no instance state.
  override onError(error: unknown): void {
    console.log("runner container error:", error);
  }

  /** Build the runner env from worker env/secrets (kills compose env block). */
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- env bag is open by nature (worker secrets passthrough); keys fixed above in RUNNER_ENV_KEYS.
  private runnerEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of RUNNER_ENV_KEYS) {
      const value = this.doEnv[key];
      // Bindings share the env bag; only string secrets cross into the container.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- env-shape guard at the worker/container boundary, not a domain contract.
      if (typeof value === "string" && value !== "") {
        out[key] = value;
      }
    }
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- same open env bag as the signature above.
    return out;
  }

  /** Ensure the container is up with fresh env, then proxy by port prefix.
   *
   * Port routing: `/{port}/...` targets that container port (tenant fleets
   * on 8100+, sync API on 18080), everything else targets the runner API on
   * 8080. `/__do/export|import` run inside the DO (R2 relay). The worker
   * rewrites Host-dispatched requests into this shape so it never needs raw
   * sockets. Every fresh container start imports the R2 snapshot before
   * serving anything but the sync API itself.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__do/export") {
      return this.handleExport();
    }
    if (url.pathname === "/__do/backup") {
      return this.handleBackup();
    }
    if (url.pathname === "/__do/restore") {
      return this.handleRestore(url.searchParams.get("date") ?? "");
    }
    const routed = parsePortPrefix(url.pathname);
    const port = routed?.port ?? RUNNER_PORT;
    const isSync = port === SYNC_PORT;
    // Import first: a fresh container serves nothing until the R2 snapshot
    // lands, so waiting on the target port beforehand just burns the
    // readiness timeout and 502s the first request.
    if (!isSync) {
      await this.ensureImported();
    }
    try {
      await this.startAndWaitForPorts({
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
        ports: [port],
        startOptions: { envVars: this.runnerEnv() },
      });
    } catch (error) {
      console.log("runner start failed:", error);
    }
    if (!routed) {
      return this.containerFetch(request);
    }
    const target = new URL(request.url);
    target.pathname = routed.rest;
    return this.containerFetch(new Request(target.toString(), request), port);
  }

  /** Fetch the runner API on 8080 through the container. */
  runnerFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.containerFetch(`http://container:${RUNNER_PORT}${path}`, init);
  }

  /** Fetch the sync API on 18080 (import window + relay, no pool needed). */
  private syncFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.containerFetch(`http://container:${SYNC_PORT}${path}`, init);
  }

  /** String env lookup (bindings share the bag; only strings cross over). */
  private stringEnv(key: string): string {
    const value = this.doEnv[key];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- env-shape guard at the worker/container boundary, not a domain contract.
    return typeof value === "string" ? value : "";
  }
  private relayBucket(): R2Bucket {
    const bucket = this.doEnv.RUNNER_SNAP;
    if (!bucket) {
      throw new Error("RUNNER_SNAP not bound");
    }
    return bucket;
  }

  /** Import-once gate: every fresh container start pulls the R2 snapshot
   * before serving anything but the sync API. Concurrent fetches share one
   * flight; failures keep the flag so the next fetch retries. */
  private ensureImported(): Promise<void> {
    if (!this.needsImport) {
      return Promise.resolve();
    }
    if (!this.importFlight) {
      this.importFlight = this.importFromR2();
    }
    return this.importFlight;
  }

  /** Push one R2 object into the sidecar (sequential caller bounds memory). */
  private async importOneObject(
    key: string,
    auth: Record<string, string>
  ): Promise<void> {
    const r2 = this.relayBucket();
    const stored = await r2.get(key);
    if (!stored) {
      return;
    }
    const put = await this.syncFetch(
      `/v1/sync/put?key=${encodeURIComponent(key)}`,
      {
        body: await stored.arrayBuffer(),
        headers: {
          ...auth,
          "content-type": "application/octet-stream",
        },
        method: "POST",
      }
    );
    if (!put.ok) {
      throw new Error(`sync put ${key}: ${put.status}`);
    }
  }

  /** Push every R2 relay object into the sidecar, then complete the boot
   * import window. Empty relay (first boot) completes immediately. */
  private async importFromR2(): Promise<void> {
    const r2 = this.relayBucket();
    await this.startAndWaitForPorts({
      ports: [SYNC_PORT],
      startOptions: { envVars: this.runnerEnv() },
    });
    const token = this.stringEnv("RUNNER_TOKEN");
    const auth = { authorization: `Bearer ${token}` };
    let cursor: string | undefined;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- cursor pagination: each page depends on the previous cursor.
      const listed = await r2.list(cursor ? { cursor } : {});
      for (const obj of listed.objects) {
        // Backup copies are restore-only: never hydrate them into the live
        // sidecar (restore strips the date prefix explicitly via /__do/restore).
        if (obj.key === MANIFEST_KEY || obj.key.startsWith("backup/")) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- bounded sequential puts: bundles can be 100s of MB, Promise.all would OOM the isolate.
        await this.importOneObject(obj.key, auth);
      }
      if (!listed.truncated) {
        break;
      }
      ({ cursor } = listed);
    }
    const done = await this.syncFetch("/v1/sync/complete", {
      headers: auth,
      method: "POST",
    });
    if (!done.ok) {
      throw new Error(`sync complete: ${done.status}`);
    }
  }

  /** Copy changed sidecar objects into R2 (etag diff against the stored
   * manifest). Never runs before the import gate — an empty sidecar must
   * not wipe the relay. */
  private async exportToR2(): Promise<{ deleted: number; pushed: number }> {
    const r2 = this.relayBucket();
    await this.startAndWaitForPorts({
      ports: [SYNC_PORT],
      startOptions: { envVars: this.runnerEnv() },
    });
    const token = this.stringEnv("RUNNER_TOKEN");
    const auth = { authorization: `Bearer ${token}` };
    // Flush a fresh snapshot first so the relay copies seconds-old state.
    // Fail-soft: a wedged runner must not wedge the relay schedule.
    await this.runnerFetch("/v1/admin/checkpoint", { method: "POST" }).catch(
      () => {
        console.log("pre-export checkpoint failed");
      }
    );
    const manifestRes = await this.syncFetch("/v1/sync/manifest", {
      headers: auth,
    });
    if (!manifestRes.ok) {
      throw new Error(`sync manifest: ${manifestRes.status}`);
    }
    const manifest = Schema.decodeUnknownSync(SyncManifestSchema)(
      await manifestRes.json()
    );
    if (!manifest.imported) {
      await this.ensureImported();
      return { deleted: 0, pushed: 0 };
    }
    const storedRaw = await r2.get(MANIFEST_KEY);
    const stored: RelayManifest = storedRaw
      ? Schema.decodeUnknownSync(RelayManifestSchema)(await storedRaw.json())
      : { objects: {} };
    const want = new Map(manifest.objects.map((o) => [o.key, o.etag] as const));
    let pushed = 0;
    for (const obj of manifest.objects) {
      if (stored.objects[obj.key] === obj.etag) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- bounded sequential gets: objects can be 100s of MB, Promise.all would OOM the isolate.
      const got = await this.syncFetch(
        `/v1/sync/get?key=${encodeURIComponent(obj.key)}`,
        { headers: auth }
      );
      if (!got.ok) {
        throw new Error(`sync get ${obj.key}: ${got.status}`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- same bounded sequential; the bytes above are already in hand one at a time.
      await r2.put(obj.key, await got.arrayBuffer(), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      pushed += 1;
    }
    const stale = Object.keys(stored.objects).filter((k) => !want.has(k));
    if (stale.length > 0) {
      await r2.delete(stale);
    }
    await r2.put(
      MANIFEST_KEY,
      JSON.stringify({ objects: Object.fromEntries(want) }),
      { httpMetadata: { contentType: "application/json" } }
    );
    return { deleted: stale.length, pushed };
  }

  /** Nightly disaster copy: telemetry is the only keyspace the 5-min relay
   * doesn't carry, so back it up under `backup/<date>/` (everything else is
   * already continuously in R2). The per-day manifest holds etags so repeat
   * runs copy only changed objects; days older than BACKUP_RETAIN_DAYS are
   * pruned. Restore is explicit (`POST /__do/restore?date=`) — never automatic.
   * Never runs before the import gate — an empty sidecar must not blank a
   * backup day. */
  private async backupToR2(): Promise<{
    copied: number;
    date: string;
    pruned: number;
  }> {
    const r2 = this.relayBucket();
    await this.startAndWaitForPorts({
      ports: [SYNC_PORT],
      startOptions: { envVars: this.runnerEnv() },
    });
    const token = this.stringEnv("RUNNER_TOKEN");
    const auth = { authorization: `Bearer ${token}` };
    await this.runnerFetch("/v1/admin/checkpoint", { method: "POST" }).catch(
      () => {
        console.log("pre-backup checkpoint failed");
      }
    );
    const manifestRes = await this.syncFetch(
      "/v1/sync/manifest?include_telemetry=1",
      { headers: auth }
    );
    if (!manifestRes.ok) {
      throw new Error(`sync manifest: ${manifestRes.status}`);
    }
    const manifest = Schema.decodeUnknownSync(SyncManifestSchema)(
      await manifestRes.json()
    );
    if (!manifest.imported) {
      await this.ensureImported();
      return { copied: 0, date: "", pruned: 0 };
    }
    const date = new Date().toISOString().slice(0, 10);
    const dayManifestKey = `backup/${date}/manifest.json`;
    const dayRaw = await r2.get(dayManifestKey);
    const day: RelayManifest = dayRaw
      ? Schema.decodeUnknownSync(RelayManifestSchema)(await dayRaw.json())
      : { objects: {} };
    let copied = 0;
    const want: Record<string, string> = {};
    for (const obj of manifest.objects) {
      if (!obj.key.includes("/telemetry/")) {
        continue;
      }
      want[obj.key] = obj.etag;
      if (day.objects[obj.key] === obj.etag) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- bounded sequential gets: objects can be 100s of MB, Promise.all would OOM the isolate.
      const got = await this.syncFetch(
        `/v1/sync/get?key=${encodeURIComponent(obj.key)}`,
        { headers: auth }
      );
      if (!got.ok) {
        throw new Error(`sync get ${obj.key}: ${got.status}`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- same bounded sequential; the bytes above are already in hand one at a time.
      await r2.put(`backup/${date}/${obj.key}`, await got.arrayBuffer(), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      copied += 1;
    }
    await r2.put(dayManifestKey, JSON.stringify({ objects: want }), {
      httpMetadata: { contentType: "application/json" },
    });
    const pruned = await this.pruneBackups(date);
    return { copied, date, pruned };
  }

  /** Delete `backup/<date>/` prefixes older than the retention window. */
  private async pruneBackups(today: string): Promise<number> {
    const cutoffDate = new Date(`${today}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - (BACKUP_RETAIN_DAYS - 1));
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const r2 = this.relayBucket();
    const stale: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- cursor pagination: each page depends on the previous cursor.
      const listed = await r2.list(
        cursor ? { cursor, prefix: "backup/" } : { prefix: "backup/" }
      );
      for (const obj of listed.objects) {
        const day = obj.key.split("/")[1] ?? "";
        if (/^\d{4}-\d{2}-\d{2}$/u.test(day) && day < cutoff) {
          stale.push(obj.key);
        }
      }
      if (!listed.truncated) {
        break;
      }
      ({ cursor } = listed);
    }
    const CHUNK = 500;
    for (let i = 0; i < stale.length; i += CHUNK) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- chunked deletes: bounded sequential R2 calls.
      await r2.delete(stale.slice(i, i + CHUNK));
    }
    return stale.length;
  }

  /** Manual disaster restore: copy `backup/<date>/` objects back to live
   * keys (date prefix stripped) through the sync API. Validates the date;
   * telemetry parquet lands back in the sidecar where the tick re-aggregates
   * it once the watermark predates it (fresh restores start empty, so no
   * double-count). */
  private async restoreFromBackup(date: string): Promise<{ restored: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      throw new Error(`bad date: ${date}`);
    }
    const r2 = this.relayBucket();
    const dayRaw = await r2.get(`backup/${date}/manifest.json`);
    if (!dayRaw) {
      throw new Error(`no backup for ${date}`);
    }
    const day = Schema.decodeUnknownSync(RelayManifestSchema)(
      await dayRaw.json()
    );
    await this.startAndWaitForPorts({
      ports: [SYNC_PORT],
      startOptions: { envVars: this.runnerEnv() },
    });
    const token = this.stringEnv("RUNNER_TOKEN");
    const auth = { authorization: `Bearer ${token}` };
    let restored = 0;
    for (const key of Object.keys(day.objects)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- bounded sequential gets: objects can be 100s of MB, Promise.all would OOM the isolate.
      const stored = await r2.get(`backup/${date}/${key}`);
      if (!stored) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- same bounded sequential; the bytes above are already in hand one at a time.
      const body = await stored.arrayBuffer();
      // oxlint-disable-next-line eslint/no-await-in-loop -- same bounded sequential put per object.
      const put = await this.syncFetch(
        `/v1/sync/put?key=${encodeURIComponent(key)}`,
        {
          body,
          headers: {
            ...auth,
            "content-type": "application/octet-stream",
          },
          method: "POST",
        }
      );
      if (!put.ok) {
        throw new Error(`sync put ${key}: ${put.status}`);
      }
      restored += 1;
    }
    return { restored };
  }

  /** Cron entrypoint (POST /__do/backup): never throws — the schedule must
   * not wedge on a wedged container. */
  private async handleBackup(): Promise<Response> {
    try {
      const counts = await this.backupToR2();
      return Response.json({ ok: true, ...counts });
    } catch (error) {
      console.log("backup failed:", error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        },
        { status: 502 }
      );
    }
  }

  /** Operator entrypoint (POST /__do/restore?date=YYYY-MM-DD). */
  private async handleRestore(date: string): Promise<Response> {
    try {
      const counts = await this.restoreFromBackup(date);
      return Response.json({ date, ok: true, ...counts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("restore failed:", error);
      let status = 502;
      if (message.startsWith("bad date")) {
        status = 400;
      } else if (message.startsWith("no backup")) {
        status = 404;
      }
      return Response.json({ error: message, ok: false }, { status });
    }
  }

  /** Cron entrypoint (POST /__do/export): never throws — the schedule must
   * not wedge on a wedged container. */
  private async handleExport(): Promise<Response> {
    try {
      const counts = await this.exportToR2();
      await this.keepaliveWhileBusy();
      return Response.json({ ok: true, ...counts });
    } catch (error) {
      console.log("relay export failed:", error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        },
        { status: 502 }
      );
    }
  }
  /** Cached slug → ports table from `GET /v1/edge/routes` (5 s TTL). */
  async edgeRoutes(): Promise<Record<string, EdgeRoute>> {
    const cached =
      (await this.doCtx.storage.get<CachedRoutes>("edge-routes")) ?? null;
    if (cached && Date.now() - cached.at < ROUTES_TTL_MS) {
      return cached.bySlug;
    }
    const token = this.stringEnv("RUNNER_TOKEN");
    const res = await this.runnerFetch("/v1/edge/routes", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // Serve stale on failure so a slow runner never 500s the edge.
      return cached?.bySlug ?? {};
    }
    const payload = Schema.decodeUnknownSync(EdgeRoutesPayloadSchema)(
      await res.json()
    );
    const bySlug: Record<string, EdgeRoute> = {};
    for (const route of payload.routes ?? []) {
      bySlug[route.slug] = route;
    }
    await this.doCtx.storage.put<CachedRoutes>("edge-routes", {
      at: Date.now(),
      bySlug,
    });
    return bySlug;
  }

  /** Extend the idle window while a build holds the runner busy. */
  async keepaliveWhileBusy(): Promise<void> {
    try {
      const res = await this.runnerFetch("/health");
      if (!res.ok) {
        return;
      }
      const body = Schema.decodeUnknownSync(HealthPayloadSchema)(
        await res.json()
      );
      if (body.busy === true) {
        await this.doCtx.container?.setInactivityTimeout?.(10 * 60 * 1000);
      }
    } catch {
      // Best-effort: a failed probe must never break the cron.
    }
  }
}
