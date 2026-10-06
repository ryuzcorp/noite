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

export interface RunnerDomain {
  appId: string;
  createdAt: string;
  hostname: string;
}

/** An app's edge rate limits in requests per minute: its own values (null =
 * the platform default) beside those defaults. 0 turns a limit off.
 * `perClient` is false when the install sits behind a proxy the edge does
 * not trust: every request then looks like one client, so per-client limits
 * are off whatever they are set to. */
export interface RunnerLimits {
  appRpm: number | null;
  clientRpm: number | null;
  defaults: { appRpm: number; clientRpm: number };
  perClient: boolean;
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

/** The runner beside this worker: the control fleet (prod) and `vite dev`
 * (dev) both run in the runner's container. */
export const RUNNER_DEFAULT_URL = "http://127.0.0.1:8080";

/** Runner base URL from the environment. */
const runnerBase = () =>
  (readEnv().RUNNER_URL ?? RUNNER_DEFAULT_URL).replace(/\/$/u, "");

/** Stamp the platform env for runner calls made on the edge fetch path.
 * Oxide only enters its ALS (readEnv) for actions, workflows and queues, so a
 * plain route handler — `/internal/git-auth`, the SSE pollers — otherwise sees
 * the localhost dev defaults and misses the real RUNNER_URL/RUNNER_TOKEN. */
export const stampRunnerEnv = (env: KitEnv): void => {
  for (const key of ["RUNNER_TOKEN", "RUNNER_URL"] as const) {
    const value = env[key];
    if (value) {
      controlEnv[key] = value;
    }
  }
};

const runnerToken = () => {
  const token = readEnv().RUNNER_TOKEN ?? "";
  if (!token) {
    throw new Error("RUNNER_TOKEN is not configured");
  }
  return token;
};

/** Bound every runner call: a hung upstream must fail with the path in the
 * message, never hang into the platform request deadline. Healthy calls
 * measure ~70ms through the public edge (a Railway worker cell cannot resolve
 * `*.railway.internal`, so that hop is the internet), so 5s leaves room for
 * the slow queries (metrics/spans read Parquet) while still failing well
 * before a browser gives up — a 10s bound surfaced as a mystery hang. */
const RUNNER_TIMEOUT_MS = 5000;
/** Log anything slower than this, with the path and the base URL: when the
 * deployed worker is the only thing we can observe, this is what attributes
 * an intermittent stall instead of guessing. */
const RUNNER_SLOW_MS = 1000;

export const runnerFetch = async <T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${runnerToken()}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const base = runnerBase();
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(RUNNER_TIMEOUT_MS),
  });
  const elapsed = Date.now() - started;
  if (elapsed >= RUNNER_SLOW_MS) {
    console.warn(
      `[runner] slow ${init.method ?? "GET"} ${path} ${elapsed}ms via ${base}`
    );
  }
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

/** `GET /v1/admin/stats`: the operator counters, plus `control_fleet` —
 * whether this image supervises the control fleet at all (the dev image does
 * not: `vite dev` serves the UI, so there is no control celld and no control
 * telemetry). The runner's JSON keys are snake_case. */
export interface RunnerAdminStats {
  control_fleet: boolean;
}

/** Whether the runner supervises the control fleet. A runner that cannot
 * answer counts as managing one: the "release image only" notice in
 * ControlAppDetail must never appear on a healthy release install. */
export const runnerControlFleet = async (): Promise<boolean> => {
  try {
    const stats = await runnerFetch<RunnerAdminStats>("/v1/admin/stats");
    return stats.control_fleet;
  } catch {
    return true;
  }
};

export const runnerListApps = () => runnerRpc<RunnerApp[]>("apps.list", {});

export const runnerCreateApp = (body: {
  name: string;
  slug: string;
  userId: string;
}) =>
  runnerRpc<RunnerApp>("apps.create", {
    name: body.name,
    slug: body.slug,
    // The runner's RPC params are snake_case.
    user_id: body.userId,
  });

export const runnerGetApp = (id: string) =>
  runnerRpc<RunnerApp>("apps.get", { id });

export const runnerGetAppBySlug = (slug: string) =>
  runnerRpc<RunnerApp>("apps.get_by_slug", { slug });

// `apps.patch` takes camelCase params (like the REST PATCH body), unlike most
// RPC methods; the runner rejects unknown keys so a mismatch fails loudly.
export const runnerPatchApp = (id: string, body: { desiredState: string }) =>
  runnerRpc<RunnerApp>("apps.patch", { desiredState: body.desiredState, id });

export const runnerDeleteApp = (id: string) =>
  runnerRpc<{ ok: boolean }>("apps.delete", { id });

export const runnerRenameApp = (
  id: string,
  body: { name?: string; slug?: string }
) => runnerRpc<RunnerApp>("apps.rename", { id, ...body });

export const runnerDeployLog = (id: string, deployId: string) =>
  runnerRpc<{ log: string }>("deploys.log", { deploy_id: deployId, id });

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

export type ErrorStatus = "open" | "resolved" | "ignored";

/** One grouped error: every occurrence sharing a fingerprint (the runner's
 * `host/errors.rs`). `hourly` is the last 24 UTC hours, oldest first. */
export interface RunnerErrorIssue {
  count: number;
  culprit: string;
  fingerprint: string;
  firstSeenUs: number;
  firstSha: string | null;
  handler: string;
  hourly: number[];
  kind: string;
  lastSeenUs: number;
  lastSha: string | null;
  message: string;
  regressed: boolean;
  source: "uncaught" | "logged";
  status: ErrorStatus;
  statusAtUs: number | null;
}

export interface RunnerErrorFrame {
  function: string;
  inApp: boolean;
  location: string;
}

/** One stored occurrence. Request fields are empty when the edge had no
 * trace for it (e.g. the runner restarted in between). */
export interface RunnerErrorEvent {
  browser: string;
  cell: string;
  context: string;
  frames: RunnerErrorFrame[];
  handler: string;
  httpStatus: number;
  kind: string;
  logs: string[];
  message: string;
  method: string;
  os: string;
  path: string;
  sha: string;
  source: "uncaught" | "logged";
  traceId: string;
  tsUs: number;
}

export interface RunnerErrorList {
  counts: Record<ErrorStatus, number>;
  issues: RunnerErrorIssue[];
}

export interface RunnerErrorDetail {
  events: RunnerErrorEvent[];
  issue: RunnerErrorIssue;
}

export const runnerGetError = (id: string, fingerprint: string) =>
  runnerRpc<RunnerErrorDetail>("errors.get", { fingerprint, id });

export const runnerSetErrorStatus = (
  id: string,
  fingerprint: string,
  status: ErrorStatus
) =>
  runnerRpc<{ ok: boolean }>("errors.set_status", { fingerprint, id, status });

/** Custom hostnames attached to an app (all of them, in hostname order). */
export const runnerListDomains = (id: string) =>
  runnerRpc<RunnerDomain[]>("domains.list", { id });

/** Reserve a hostname. The runner validates the shape and rejects a hostname
 * the platform owns or another app already holds. */
export const runnerAddDomain = (id: string, hostname: string) =>
  runnerRpc<RunnerDomain[]>("domains.add", { hostname, id });

export const runnerRemoveDomain = (id: string, hostname: string) =>
  runnerRpc<RunnerDomain[]>("domains.remove", { hostname, id });

export const runnerGetLimits = (id: string) =>
  runnerRpc<RunnerLimits>("limits.get", { id });

/** Replace both limits; null returns one to the platform default. */
export const runnerSetLimits = (
  id: string,
  clientRpm: number | null,
  appRpm: number | null
) => runnerRpc<RunnerLimits>("limits.set", { appRpm, clientRpm, id });

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

/** One folder row of an R2 listing: the key prefix a browser descends into. */
export interface R2Folder {
  name: string;
  prefix: string;
}

export interface R2Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  contentType: string | null;
  etag: string | null;
}

export interface R2Preview {
  appId: string;
  appSlug: string;
  bucket: string;
  /** The folder this page lists (decoded key prefix, "" at the bucket root). */
  prefix: string;
  folders: R2Folder[];
  objects: R2Object[];
  /** Continuation token for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface R2File {
  key: string;
  size: number;
  truncated: boolean;
  contentType: string | null;
  text: string | null;
}

/** One cell as the UI sees it: SQL NULL is null; everything else is its exact
 * text (integers/reals stringified server-side so nothing loses precision in
 * transit). Blobs: hex string prefixed `x'…'` (read-only in the editor). */
export type D1Cell = string | null;

/** One table's write capabilities in the D1 editor. */
export interface D1TableCaps {
  delete: boolean;
  insert: boolean;
  update: boolean;
}

export interface D1TableInfo {
  name: string;
  rowCount: number;
  /** Write capabilities for this table (the caller's tenant role, or the
   * control D1 policy). Absent means read-only. */
  caps?: D1TableCaps;
}

export interface D1Tables {
  databaseId: string;
  tables: D1TableInfo[];
}

export interface D1Column {
  name: string;
  /** Declared type; "" when the DDL has none. */
  type: string;
  notNull: boolean;
  /** DDL default expression text; null when none. */
  defaultValue: string | null;
  /** 0 = not part of the PK, else 1-based position. */
  pk: number;
}

export interface D1ForeignKey {
  from: string;
  table: string;
  to: string;
}

export interface D1Index {
  name: string;
  unique: boolean;
  columns: string[];
}

/** Link from a row to the admin action that owns it (control D1 only). */
export interface D1RowAction {
  /** Column whose cell value prefills the target search. */
  column: string;
  label: string;
  /** Query param the target tab's search form reads (`uq`, `iq`). */
  param: string;
  /** Admin-home tab id (`t`). */
  tab: string;
}

export interface D1TableSchema {
  table: string;
  columns: D1Column[];
  foreignKeys: D1ForeignKey[];
  indexes: D1Index[];
  /** CREATE statement from sqlite_master; null when unavailable. */
  sql: string | null;
  /** Computed by the action layer (the caller's role, or the control D1
   * policy). */
  caps: D1TableCaps;
  /** column -> note for columns the editor must not write (e.g. "managed in
   * Users", "redacted"). {} for tenant tables. */
  locked: Record<string, string>;
  /** Columns whose values are masked ("•••• redacted") and cannot be
   * filtered, sorted or searched (control D1 only; [] otherwise). */
  redacted: string[];
  rowAction: D1RowAction | null;
}

/** What the runner's `storage.d1.schema` returns: the schema without the
 * policy/role parts the action layer computes. */
export type D1TableSchemaRaw = Omit<
  D1TableSchema,
  "caps" | "locked" | "redacted" | "rowAction"
>;

export type D1FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "like"
  | "is_null"
  | "not_null";

export interface D1Filter {
  column: string;
  op: D1FilterOp;
  /** Ignored for is_null/not_null; `like` takes the user's pattern with `%`
   * wildcards as typed. */
  value: string;
}

export interface D1RowsQuery {
  table: string;
  /** 0-based. */
  page: number;
  /** One of 25 | 50 | 100; the server clamps to 1..100. */
  pageSize: number;
  /** null = primary key order (rowid when the table has no PK). */
  sort: { column: string; desc: boolean } | null;
  /** AND-ed; at most 10. */
  filters: D1Filter[];
  /** "" = none; case-insensitive substring over every non-redacted column. */
  search: string;
}

export interface D1Rows {
  table: string;
  /** Column order of `rows`. */
  columns: string[];
  rows: D1Cell[][];
  /** COUNT(*) under the same filters/search. */
  total: number;
  page: number;
  pageSize: number;
}

/** Row identity for update/delete: the PK columns' current values; tables
 * without a PK use every column's value. */
export type D1Key = Record<string, D1Cell>;

export interface D1WriteBody {
  op: "insert" | "update" | "delete";
  table: string;
  /** update/delete. */
  key?: D1Key;
  /** insert/update; null = SQL NULL, "" = empty string. Insert: omitted
   * columns get their DDL default. */
  values: Record<string, D1Cell>;
}

/** One `deleteRows` call: 1..100 keys, all-or-nothing where the backend
 * allows. */
export interface D1DeleteRowsBody {
  table: string;
  keys: D1Key[];
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

/** Tables + row counts of one app D1 database (counts in one batch). */
export const runnerD1Tables = (id: string, databaseId: string) =>
  runnerRpc<D1Tables>("storage.d1.tables", { database_id: databaseId, id });

/** One table's schema; the action adds caps (role dependent). */
export const runnerD1Schema = (id: string, databaseId: string, table: string) =>
  runnerRpc<D1TableSchemaRaw>("storage.d1.schema", {
    database_id: databaseId,
    id,
    table,
  });

/** One server-side page of rows (sort/filters/search applied in SQL). */
export const runnerD1Rows = (
  id: string,
  databaseId: string,
  query: D1RowsQuery
) =>
  runnerRpc<D1Rows>("storage.d1.rows", {
    database_id: databaseId,
    filters: query.filters,
    id,
    page: query.page,
    page_size: query.pageSize,
    search: query.search,
    sort: query.sort,
    table: query.table,
  });

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

/** Curated tenant-DB write: single INSERT, UPDATE or DELETE (push-gated in
 * the action). */
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

/** Delete 1..100 rows by key in one atomic batch (push-gated in the action). */
export const runnerD1DeleteRows = (
  id: string,
  databaseId: string,
  body: D1DeleteRowsBody
) =>
  runnerRpc<{ deleted: number; ok: boolean }>("storage.d1.delete_rows", {
    database_id: databaseId,
    id,
    ...body,
  });

/** Read-only Durable Object instance list for one class. */
export const runnerDoInstances = (id: string, className: string) =>
  runnerRpc<DoPreview>("storage.do.list", { class_name: className, id });

/** One page of an R2 bucket folder (prefix + delimiter on the store). */
export const runnerR2List = (
  id: string,
  bucket: string,
  prefix: string,
  cursor: string | null
) =>
  runnerRpc<R2Preview>("storage.r2.list", {
    bucket,
    cursor,
    id,
    prefix,
  });

/** Read-only R2 object fetch (bounded text preview, null when binary). */
export const runnerR2Get = (id: string, bucket: string, key: string) =>
  runnerRpc<R2File>("storage.r2.get", { bucket, id, key });

/** Delete 1..100 R2 objects in one call (push-gated in the action). */
export const runnerR2Delete = (id: string, bucket: string, keys: string[]) =>
  runnerRpc<{ deleted: number }>("storage.r2.delete", { bucket, id, keys });

/** Browser download URL for one R2 object (UI proxy route — the browser
 * never sees RUNNER_TOKEN; the route gates on session + view role). */
export const r2DownloadUrl = (appId: string, bucket: string, key: string) =>
  `/storage/${encodeURIComponent(appId)}/r2/${encodeURIComponent(bucket)}/raw?key=${encodeURIComponent(key)}`;

/** Browser upload URL for one R2 object: the UI proxy route streams the body
 * to the runner, which stores it with `celld r2 put` (session + push gate). */
export const r2UploadUrl = (appId: string, bucket: string, key: string) =>
  `/storage/${encodeURIComponent(appId)}/r2/${encodeURIComponent(bucket)}/upload?key=${encodeURIComponent(key)}`;

/** Largest upload the UI offers; the runner enforces the same cap. */
export const R2_UPLOAD_LIMIT = 64 * 1024 * 1024;
