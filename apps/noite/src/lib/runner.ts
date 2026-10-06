/** Server-side client for the Rust runner. Browser never sees RUNNER_TOKEN. */
import { useEnv } from "oxidejs";

import { controlEnv, hydrateControlEnv } from "./control-env";
// Wire types, generated from the Rust structs in apps/runner into
// ./runner-types (never edit those files by hand). Regenerate with `cargo
// test` in apps/runner; CI fails on drift. The `Runner*` names are the UI's
// long-standing aliases for the generated Rust names; the ones used in the
// call signatures below are imported, and every one is re-exported.
import type { App as RunnerApp } from "./runner-types/App";
import type { AppDomain as RunnerDomain } from "./runner-types/AppDomain";
import type { AppEnv as RunnerEnv } from "./runner-types/AppEnv";
import type { AppUserProps as RunnerUserProps } from "./runner-types/AppUserProps";
import type { BlobResponse as RunnerBlob } from "./runner-types/BlobResponse";
import type { D1DeleteRowsBody } from "./runner-types/D1DeleteRowsBody";
import type { D1Filter } from "./runner-types/D1Filter";
import type { D1Rows } from "./runner-types/D1Rows";
import type { D1Sort } from "./runner-types/D1Sort";
import type { D1TableInfo as D1TableInfoBase } from "./runner-types/D1TableInfo";
import type { D1Tables as D1TablesRaw } from "./runner-types/D1Tables";
import type { D1TableSchemaRaw } from "./runner-types/D1TableSchemaRaw";
import type { D1WriteBody } from "./runner-types/D1WriteBody";
import type { DiffResponse as RunnerDiff } from "./runner-types/DiffResponse";
import type { DoPreview } from "./runner-types/DoPreview";
import type { ErrorIssueDetail as RunnerErrorDetail } from "./runner-types/ErrorIssueDetail";
import type { GitRemote as RunnerGitRemote } from "./runner-types/GitRemote";
import type { LimitsView as RunnerLimits } from "./runner-types/LimitsView";
import type { R2File } from "./runner-types/R2File";
import type { R2Preview } from "./runner-types/R2Preview";
import type { SourceCommitBody } from "./runner-types/SourceCommitBody";
import type { StorageItem } from "./runner-types/StorageItem";
import type { TelemetryStatus as RunnerTelemetryStatus } from "./runner-types/TelemetryStatus";
import type { TreeResponse as RunnerTree } from "./runner-types/TreeResponse";

export type { App as RunnerApp } from "./runner-types/App";
export type { AppDeviceStat as RunnerDevice } from "./runner-types/AppDeviceStat";
export type { AppDomain as RunnerDomain } from "./runner-types/AppDomain";
export type { AppEnv as RunnerEnv } from "./runner-types/AppEnv";
export type { AppEvent as RunnerEvent } from "./runner-types/AppEvent";
export type { AppInsight as RunnerInsight } from "./runner-types/AppInsight";
export type { AppMetric as RunnerMetric } from "./runner-types/AppMetric";
export type { AppPathStat as RunnerPath } from "./runner-types/AppPathStat";
export type { AppRefStat as RunnerRef } from "./runner-types/AppRefStat";
export type { AppSpanStat as RunnerSpan } from "./runner-types/AppSpanStat";
export type { AppUserProps as RunnerUserProps } from "./runner-types/AppUserProps";
export type { BlobResponse as RunnerBlob } from "./runner-types/BlobResponse";
export type { D1Column } from "./runner-types/D1Column";
export type { D1DeleteRowsBody } from "./runner-types/D1DeleteRowsBody";
export type { D1Filter } from "./runner-types/D1Filter";
export type { D1FilterOp } from "./runner-types/D1FilterOp";
export type { D1ForeignKey } from "./runner-types/D1ForeignKey";
export type { D1Index } from "./runner-types/D1Index";
export type { D1Rows } from "./runner-types/D1Rows";
export type { D1Sort } from "./runner-types/D1Sort";
export type { D1TableSchemaRaw } from "./runner-types/D1TableSchemaRaw";
export type { D1WriteBody } from "./runner-types/D1WriteBody";
export type { D1WriteOp } from "./runner-types/D1WriteOp";
export type { Deploy as RunnerDeploy } from "./runner-types/Deploy";
export type { DiffResponse as RunnerDiff } from "./runner-types/DiffResponse";
export type { DoInstance } from "./runner-types/DoInstance";
export type { DoPreview } from "./runner-types/DoPreview";
export type { ErrorEventView as RunnerErrorEvent } from "./runner-types/ErrorEventView";
export type { ErrorIssueDetail as RunnerErrorDetail } from "./runner-types/ErrorIssueDetail";
export type { ErrorIssueList as RunnerErrorList } from "./runner-types/ErrorIssueList";
export type { ErrorIssueView as RunnerErrorIssue } from "./runner-types/ErrorIssueView";
export type { Frame as RunnerErrorFrame } from "./runner-types/Frame";
export type { GitRemote as RunnerGitRemote } from "./runner-types/GitRemote";
export type { LimitsView as RunnerLimits } from "./runner-types/LimitsView";
export type { R2File } from "./runner-types/R2File";
export type { R2Folder } from "./runner-types/R2Folder";
export type { R2Object } from "./runner-types/R2Object";
export type { R2Preview } from "./runner-types/R2Preview";
export type { SourceCommitBody } from "./runner-types/SourceCommitBody";
export type { SourceCommitFile } from "./runner-types/SourceCommitFile";
export type { StorageItem } from "./runner-types/StorageItem";
export type { TelemetryEvent as RunnerTelemetryEvent } from "./runner-types/TelemetryEvent";
export type { TelemetryStatus as RunnerTelemetryStatus } from "./runner-types/TelemetryStatus";
export type { TreeEntry } from "./runner-types/TreeEntry";
export type { TreeResponse as RunnerTree } from "./runner-types/TreeResponse";

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

/** Anonymous instance telemetry: effective + stored state, the lock, the last
 * successful send and the exact payload the next send would POST. */
export const runnerTelemetryGet = () =>
  runnerRpc<RunnerTelemetryStatus>("telemetry.get", {});

/** Store the opt-out preference; returns the same status shape. While the
 * setting is locked the preference is stored but effective stays disabled. */
export const runnerTelemetrySet = (enabled: boolean) =>
  runnerRpc<RunnerTelemetryStatus>("telemetry.set", { enabled });

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

export const runnerListEnv = (id: string) =>
  runnerRpc<RunnerEnv[]>("env.list", { id });

export const runnerSetEnv = (id: string, name: string, value: string) =>
  runnerRpc<{ ok: boolean; name: string }>("env.set", { id, name, value });

export const runnerDeleteEnv = (id: string, name: string) =>
  runnerRpc<{ ok: boolean }>("env.delete", { id, name });

export type ErrorStatus = "open" | "resolved" | "ignored";

// RunnerErrorIssue/Frame/Event/List/Detail come from ./runner-types
// (generated from models::ErrorIssue, host::errors::Frame and
// service::errors::{ErrorIssueView, ErrorEventView, ErrorIssueList,
// ErrorIssueDetail}).

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

// RunnerTree/Blob/Diff are generated from host::source::{TreeResponse,
// BlobResponse, DiffResponse}.

export const runnerSourceTree = (id: string) =>
  runnerRpc<RunnerTree>("source.tree", { id });

export const runnerSourceBlob = (id: string, path: string) =>
  runnerRpc<RunnerBlob>("source.blob", { id, path });

export const runnerSourceDiff = (id: string) =>
  runnerRpc<RunnerDiff>("source.diff", { id });

// RunnerMetric/Span/Device/Path/Ref/Event/UserProps/Insight are generated
// from the models::App*Stat rows, models::AppEvent, AppUserProps and
// AppInsight.

export const runnerGetUserProps = (id: string, userId: string) =>
  runnerRpc<RunnerUserProps | null>("events.user_props", {
    id,
    user_id: userId,
  });

// StorageItem and the R2Folder/Object/Preview/File shapes are generated from
// host::storage::StorageItem and host::storage::r2.

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

/** A runner table row plus the caps the UI server computes for the caller
 * (the runner reports only name + rowCount). Absent caps means read-only. */
export interface D1TableInfo extends D1TableInfoBase {
  caps?: D1TableCaps;
}

/** A D1 database listing where each table carries the caps the UI server
 * computed (the runner's `storage.d1.tables` has no caps). */
export interface D1Tables extends Omit<D1TablesRaw, "tables"> {
  tables: D1TableInfo[];
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

/** One table's schema plus the policy/role parts the UI server computes on
 * top of the runner's raw schema (`storage.d1.schema`). */
export interface D1TableSchema extends D1TableSchemaRaw {
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

// D1FilterOp and D1Filter are generated from host::storage::d1.

export interface D1RowsQuery {
  table: string;
  /** 0-based. */
  page: number;
  /** One of 25 | 50 | 100; the server clamps to 1..100. */
  pageSize: number;
  /** null = primary key order (rowid when the table has no PK). */
  sort: D1Sort | null;
  /** AND-ed; at most 10. */
  filters: D1Filter[];
  /** "" = none; case-insensitive substring over every non-redacted column. */
  search: string;
}

/** Row identity for update/delete: the PK columns' current values; tables
 * without a PK use every column's value. */
export type D1Key = Record<string, D1Cell>;

// D1Rows, D1WriteBody and D1DeleteRowsBody are generated from
// host::storage::d1; the delete body's `keys` are D1Keys.

/** D1 databases + DO classes declared by an app's deployed config. */
export const runnerStorage = (id: string) =>
  runnerRpc<StorageItem[]>("storage.list", { id });

/** Tables + row counts of one app D1 database (counts in one batch). */
export const runnerD1Tables = (id: string, databaseId: string) =>
  runnerRpc<D1TablesRaw>("storage.d1.tables", {
    database_id: databaseId,
    id,
  });

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

// SourceCommitFile/Body are generated from service::source.

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
