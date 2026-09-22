/** Server-side client for the Rust runner. Browser never sees RUNNER_TOKEN. */
import { useEnv } from "oxidejs";

import { controlEnv, hydrateControlEnv } from "./control-env";

export interface RunnerApp {
  id: string;
  slug: string;
  name: string;
  userId: string;
  status: string;
  subdomain: string;
  gitPrefix: string;
  fleetBucket: string;
  listenPort: number | null;
  internalPort: number | null;
  lastDeploySha: string | null;
  lastError: string | null;
  desiredState: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerDeploy {
  id: string;
  appId: string;
  sha: string | null;
  status: string;
  log: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerGitRemote {
  remote: string;
  url: string;
  username: string;
  s3Remote: string;
  endpoint: string;
  bucket: string;
  prefix: string;
}

const alsEnv = (): KitEnv | undefined => {
  try {
    return useEnv<KitEnv>();
  } catch {
    return undefined;
  }
};

const readEnv = (): KitEnv => {
  hydrateControlEnv();
  const merged = {
    ...controlEnv,
    ...(typeof process === "undefined" ? undefined : process.env),
    ...alsEnv(),
  };
  // SAFETY: merged carries the union of controlEnv defaults, process.env, and the ALS env — all keyed by the same env names KitEnv declares; unset string keys are left undefined which callers already tolerate.
  return merged as KitEnv;
};

const runnerBase = () =>
  (
    readEnv().RUNNER_URL ??
    readEnv().HOST_URL ??
    readEnv().AGENT_URL ??
    "http://runner:8080"
  ).replace(/\/$/u, "");

/** Minimal container-stub surface the worker uses (fetch only). */
export interface RunnerContainerStub {
  fetch: (request: Request) => Promise<Response>;
}

/** DO stub for the runner container, or null outside container target.
 * Shared by runnerFetch, Host dispatch, and the R2 relay cron. */
export const runnerContainerStub =
  async (): Promise<RunnerContainerStub | null> => {
    if (readEnv().RUNNER_TARGET !== "container") {
      return null;
    }
    const binding = readEnv().RUNNER;
    if (!binding) {
      return null;
    }
    // Platform-specific: @cloudflare/containers only exists in the worker
    // runtime, not vite dev SSR — dynamic import keeps dev working.
    const { getContainer } = await import(
      // oxlint-disable-next-line eslint/no-inline-comments -- @vite-ignore must sit inside the import call or vite bundles a worker-only module.
      /* @vite-ignore */ "@cloudflare/containers"
    );
    // SAFETY: RUNNER is a DO namespace binding; getContainer takes it opaque and only fetches through the stub below.
    const stub: RunnerContainerStub = getContainer(binding as never);
    return stub;
  };

const runnerToken = () => {
  const token =
    readEnv().RUNNER_TOKEN ??
    readEnv().HOST_TOKEN ??
    readEnv().AGENT_TOKEN ??
    "";
  if (!token) {
    throw new Error("RUNNER_TOKEN is not configured");
  }
  return token;
};

export const runnerFetch = async <T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${runnerToken()}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  // Container target (Phase 2, behind RUNNER_TARGET=container): in-worker
  // calls go getContainer(env.RUNNER).fetch(...) → runner API on 8080.
  // Compose stays the default until the cutover.
  const stub = await runnerContainerStub();
  if (stub) {
    // SAFETY: fetch body is JSON/string/undefined from callers above; workers require BodyInit so narrow here for the container Request.
    const body = init.body as BodyInit | undefined;
    const res = await stub.fetch(
      new Request(`http://runner${path}`, {
        body,
        headers,
        method: init.method ?? "GET",
        signal: init.signal ?? AbortSignal.timeout(10_000),
      })
    );
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(
        `runner ${init.method ?? "GET"} ${path}: ${res.status} ${text}`
      );
    }
    if (res.status === 204) {
      // SAFETY: 204 (no content) is only used by void/empty responses; callers type those `T`s as `void` or discard the value.
      // oxlint-disable-next-line typescript/no-invalid-void-type
      return undefined as T;
    }
    const payload = await res.json();
    // SAFETY: the runner returns the response object directly (no `{ body }` envelope); the JSON already matches the caller's requested `T`.
    return payload as T;
  }
  // Bound every runner call: a hung upstream must fail fast with the path
  // in the message, never hang into the platform request deadline.
  const res = await fetch(`${runnerBase()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `runner ${init.method ?? "GET"} ${path}: ${res.status} ${text}`
    );
  }
  if (res.status === 204) {
    // SAFETY: 204 (no content) is only used by void/empty responses; callers type those `T`s as `void` or discard the value.
    // oxlint-disable-next-line typescript/no-invalid-void-type
    return undefined as T;
  }
  const payload = await res.json();
  // SAFETY: the runner returns the response object directly (no `{ body }` envelope); the JSON already matches the caller's requested `T`.
  return payload as T;
};

interface JsonRpcEnvelope<T> {
  error?: { code: number; message: string };
  id: number;
  jsonrpc: string;
  result?: T;
}

let rpcId = 0;

export const runnerRpc = async <T = unknown>(
  method: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- params differ per method; the server parses per-method and rejects mismatches with InvalidParams.
  params: Record<string, unknown>
): Promise<T> => {
  rpcId += 1;
  const payload = await runnerFetch<JsonRpcEnvelope<T>>("/rpc", {
    body: JSON.stringify({ id: rpcId, jsonrpc: "2.0", method, params }),
    method: "POST",
  });
  if (payload.error) {
    throw new Error(
      `runner rpc ${method}: ${payload.error.code} ${payload.error.message}`
    );
  }
  // SAFETY: JSON-RPC success responses always carry `result`; error responses throw above.
  return payload.result as T;
};

export interface RpcCall {
  method: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- same per-method params contract as runnerRpc above.
  params: Record<string, unknown>;
}

/** Batch several RPC calls into one POST /rpc round-trip. Results come
 * back in call order; the first per-call error throws with its method. */
export const runnerRpcBatch = async <T = unknown>(
  calls: RpcCall[]
): Promise<T[]> => {
  const base = rpcId;
  const body = calls.map((call, i) => ({
    id: base + i + 1,
    jsonrpc: "2.0",
    method: call.method,
    params: call.params,
  }));
  rpcId += calls.length;
  const payload = await runnerFetch<JsonRpcEnvelope<T>[]>("/rpc", {
    body: JSON.stringify(body),
    method: "POST",
  });
  return body.map((call) => {
    const res = payload.find((p) => p.id === call.id);
    if (!res) {
      throw new Error(`runner rpc batch: missing response for ${call.method}`);
    }
    if (res.error) {
      throw new Error(
        `runner rpc ${call.method}: ${res.error.code} ${res.error.message}`
      );
    }
    // SAFETY: same envelope contract as runnerRpc; errors throw above.
    return res.result as T;
  });
};

export const runnerListApps = () => runnerRpc<RunnerApp[]>("apps.list", {});

export const runnerCreateApp = (body: { name: string; slug: string }) =>
  runnerRpc<RunnerApp>("apps.create", body);

export const runnerGetApp = (id: string) =>
  runnerRpc<RunnerApp>("apps.get", { id });

export const runnerPatchApp = (id: string, body: { desiredState: string }) =>
  runnerRpc<RunnerApp>("apps.patch", { desired_state: body.desiredState, id });

export const runnerDeleteApp = (id: string) =>
  runnerRpc<{ ok: boolean }>("apps.delete", { id });

export const runnerRenameApp = (
  id: string,
  body: { name?: string; slug?: string }
) => runnerRpc<RunnerApp>("apps.rename", { id, ...body });

export const runnerListDeploys = (id: string) =>
  runnerRpc<RunnerDeploy[]>("deploys.list", { id });

export const runnerRollback = (id: string, sha: string) =>
  runnerRpc<{ ok: boolean; sha: string }>("deploys.rollback", { id, sha });

export interface RunnerEnv {
  appId: string;
  name: string;
  value: string;
  updatedAt: string;
}

export const runnerListEnv = (id: string) =>
  runnerRpc<RunnerEnv[]>("env.list", { id });

export const runnerSetEnv = (id: string, name: string, value: string) =>
  runnerRpc<{ ok: boolean; name: string }>("env.set", { id, name, value });

export const runnerDeleteEnv = (id: string, name: string) =>
  runnerRpc<{ ok: boolean }>("env.delete", { id, name });

export const runnerGitRemote = (id: string) =>
  runnerRpc<RunnerGitRemote>("git.remote", { id });

export interface RunnerTree {
  sha: string;
  files: { path: string; size: number }[];
  truncated: boolean;
}

export interface RunnerBlob {
  sha: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  text: string;
}

export interface RunnerDiff {
  sha: string;
  parent: string | null;
  patch: string;
  truncated: boolean;
}

export const runnerSourceTree = (id: string) =>
  runnerRpc<RunnerTree>("source.tree", { id });

export const runnerSourceBlob = (id: string, path: string) =>
  runnerRpc<RunnerBlob>("source.blob", { id, path });

export const runnerSourceDiff = (id: string) =>
  runnerRpc<RunnerDiff>("source.diff", { id });

export interface RunnerMetric {
  appId: string;
  bucketTs: string;
  requests: number;
  errors: number;
  latencyMs: number;
  cpuMs: number;
}

export const runnerAppMetrics = (id: string, hours = 24) =>
  runnerRpc<RunnerMetric[]>("metrics.get", { hours, id });

export interface RunnerSpan {
  name: string;
  kind: number;
  n: number;
  ms: number;
  err: number;
  qwaitMs: number;
}

export interface RunnerDevice {
  bucketTs: string;
  browser: string;
  os: string;
  requests: number;
}

export interface RunnerPath {
  bucketTs: string;
  path: string;
  requests: number;
}

export interface RunnerRef {
  bucketTs: string;
  source: string;
  requests: number;
}

export const runnerAppSpans = (id: string, hours = 1) =>
  runnerRpc<RunnerSpan[]>("spans.get", { hours, id });

export interface RunnerEvent {
  id: string;
  appId: string;
  channel: string;
  event: string;
  description: string;
  icon: string;
  tags: string;
  userId: string;
  ts: string;
}

export interface RunnerUserProps {
  appId: string;
  userId: string;
  properties: string;
  updatedAt: string;
}

export interface RunnerInsight {
  appId: string;
  title: string;
  value: string;
  num: number | null;
  icon: string;
  updatedAt: string;
}

export const runnerListEvents = (id: string, channel?: string, limit = 50) =>
  runnerRpc<RunnerEvent[]>("events.list", { channel, id, limit });

export const runnerListEventChannels = (id: string) =>
  runnerRpc<string[]>("events.channels", { id });

export const runnerListInsights = (id: string) =>
  runnerRpc<RunnerInsight[]>("events.insights", { id });

export const runnerGetUserProps = (id: string, userId: string) =>
  runnerRpc<RunnerUserProps | null>("events.user_props", {
    id,
    user_id: userId,
  });

export interface StorageItem {
  appId: string;
  appSlug: string;
  appName: string;
  // "d1" | "do" | "r2"
  kind: string;
  id: string;
  name: string;
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: string;
}

export interface R2Preview {
  appId: string;
  appSlug: string;
  bucket: string;
  objects: R2Object[];
}

export interface R2File {
  key: string;
  size: number;
  truncated: boolean;
  text: string | null;
}

export interface D1Preview {
  appId: string;
  appSlug: string;
  databaseId: string;
  tables: string[];
  rows: string[];
  /** Per-table PRAGMA table_info --json (parallel to tables). */
  schemas: string[];
}

export interface DoPreview {
  appId: string;
  appSlug: string;
  className: string;
  instances: {
    id: string;
    scope: string;
    preview: string | null;
  }[];
}

/** D1 databases + DO classes declared by an app's deployed config. */
export const runnerStorage = (id: string) =>
  runnerRpc<StorageItem[]>("storage.list", { id });

/** Curated read-only D1 preview: tables + first rows. */
export const runnerD1 = (id: string, databaseId: string, rows = 20) =>
  runnerRpc<D1Preview>("storage.d1.get", { database_id: databaseId, id, rows });

export interface D1WriteBody {
  key?: Record<string, string | null>;
  op: "insert" | "update" | "delete";
  table: string;
  values: Record<string, string | null>;
}

/** Curated tenant-DB write: single INSERT or UPDATE (push-gated in the action). */
export interface SourceCommitFile {
  content: string;
  path: string;
}

export interface SourceCommitBody {
  author: string;
  files: readonly SourceCommitFile[];
  message: string;
}

/** Browser-edit commit: validated files become a main commit that deploys
 * like a stock push (push-gated in the action). */
export const runnerSourceCommit = (id: string, body: SourceCommitBody) =>
  runnerRpc<{ sha: string }>("source.commit", { id, ...body });

export const runnerD1Write = (
  id: string,
  databaseId: string,
  body: D1WriteBody
) =>
  runnerRpc<{ ok: boolean }>("storage.d1.write", {
    database_id: databaseId,
    id,
    ...body,
  });

/** Read-only Durable Object instance list for one class. */
export const runnerDoInstances = (id: string, className: string) =>
  runnerRpc<DoPreview>("storage.do.list", { class_name: className, id });

/** Read-only R2 key listing for one bucket. */
export const runnerR2List = (id: string, bucket: string) =>
  runnerRpc<R2Preview>("storage.r2.list", { bucket, id });

/** Read-only R2 object fetch (bounded text preview, null when binary). */
export const runnerR2Get = (id: string, bucket: string, key: string) =>
  runnerRpc<R2File>("storage.r2.get", { bucket, id, key });

/** Delete one R2 object by key. */
export const runnerR2Delete = (id: string, bucket: string, key: string) =>
  runnerRpc<{ ok: boolean }>("storage.r2.delete", { bucket, id, key });

/** Browser download URL for one R2 object (UI proxy route — the browser
 * never sees RUNNER_TOKEN; the route gates on session + view role). */
export const r2DownloadUrl = (appId: string, bucket: string, key: string) =>
  `/storage/${encodeURIComponent(appId)}/r2/${encodeURIComponent(bucket)}/raw?key=${encodeURIComponent(key)}`;
