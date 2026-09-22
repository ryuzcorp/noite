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
 * every container start, export on cron. Telemetry stays sidecar-local
 * (moves reset the metrics watermark — already today's semantic).
 */
import { Container } from "@cloudflare/containers";
import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";

const RUNNER_PORT = 8080;
const SYNC_PORT = 18_080;
const ROUTES_TTL_MS = 5000;
const MANIFEST_KEY = "runner/manifest.json";

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
    if (url.pathname === "/__do/import") {
      await this.ensureImported();
      return Response.json({ ok: true });
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
        if (obj.key === MANIFEST_KEY) {
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
