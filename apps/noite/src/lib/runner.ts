/* oxlint-disable eslint/max-classes-per-file -- the two runner error classes are the transport contract: a caught runner error is one of them. */
import { SOURCE_FORWARD_TIMEOUT_MS } from "./commit-source";
import { controlEnv, hydrateControlEnv } from "./control-env";
import { errorMessage } from "./errors";
// Wire types, generated from the Rust structs in apps/runner into
// ./runner-types (never edit those files by hand). Regenerate with `cargo
// test` in apps/runner; CI fails on drift. The `Runner*` names are the UI's
// long-standing aliases for the generated Rust names; the ones used in the
// call signatures below are imported, and every one is re-exported.
import type { App as RunnerApp } from "./runner-types/App";
import type { AppDomain as RunnerDomain } from "./runner-types/AppDomain";
import type { AppEnv as RunnerEnv } from "./runner-types/AppEnv";
import type { AppEvent as RunnerEvent } from "./runner-types/AppEvent";
import type { AppInsight as RunnerInsight } from "./runner-types/AppInsight";
import type { AppUserProps as RunnerUserProps } from "./runner-types/AppUserProps";
import type { BlobResponse as RunnerBlob } from "./runner-types/BlobResponse";
import type { BranchRules } from "./runner-types/BranchRules";
import type { D1DeleteRowsBody } from "./runner-types/D1DeleteRowsBody";
import type { D1Filter } from "./runner-types/D1Filter";
import type { D1Rows } from "./runner-types/D1Rows";
import type { D1Sort } from "./runner-types/D1Sort";
import type { D1TableInfo as D1TableInfoBase } from "./runner-types/D1TableInfo";
import type { D1Tables as D1TablesRaw } from "./runner-types/D1Tables";
import type { D1TableSchemaRaw } from "./runner-types/D1TableSchemaRaw";
import type { D1WriteBody } from "./runner-types/D1WriteBody";
import type { Deploy as RunnerDeploy } from "./runner-types/Deploy";
import type { DoPreview } from "./runner-types/DoPreview";
import type { EnvGrant } from "./runner-types/EnvGrant";
import type { Environment as RunnerEnvironment } from "./runner-types/Environment";
import type { ErrorIssueDetail as RunnerErrorDetail } from "./runner-types/ErrorIssueDetail";
import type { ErrorIssueList as RunnerErrorList } from "./runner-types/ErrorIssueList";
import type { GitBranch } from "./runner-types/GitBranch";
import type { GitCommitDetail } from "./runner-types/GitCommitDetail";
import type { GitCompare } from "./runner-types/GitCompare";
import type { GitLog } from "./runner-types/GitLog";
import type { GitRefs } from "./runner-types/GitRefs";
import type { GitRemote as RunnerGitRemote } from "./runner-types/GitRemote";
import type { IngestKeyView as RunnerIngestKey } from "./runner-types/IngestKeyView";
import type { LimitsView as RunnerLimits } from "./runner-types/LimitsView";
import type { PrComment } from "./runner-types/PrComment";
import type { PrDetail } from "./runner-types/PrDetail";
import type { PrList } from "./runner-types/PrList";
import type { R2File } from "./runner-types/R2File";
import type { R2Preview } from "./runner-types/R2Preview";
import type { SourceCommitBody } from "./runner-types/SourceCommitBody";
import type { StorageItem } from "./runner-types/StorageItem";
import type { TelemetryStatus as RunnerTelemetryStatus } from "./runner-types/TelemetryStatus";
import type { TreeResponse as RunnerTree } from "./runner-types/TreeResponse";
import type { UpdateStatus as RunnerUpdateStatus } from "./runner-types/UpdateStatus";
import type { SentryEventItem } from "./sentry-envelope";
/** Server-side client for the Rust runner. Browser never sees RUNNER_TOKEN. */

export type { App as RunnerApp } from "./runner-types/App";

export type { AppDomain as RunnerDomain } from "./runner-types/AppDomain";

export type { AppEnv as RunnerEnv } from "./runner-types/AppEnv";

export type { AppEvent as RunnerEvent } from "./runner-types/AppEvent";

export type { AppInsight as RunnerInsight } from "./runner-types/AppInsight";

export type { AppMetric as RunnerMetric } from "./runner-types/AppMetric";

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

export type { DoInstance } from "./runner-types/DoInstance";

export type { DoPreview } from "./runner-types/DoPreview";

export type { EnvGrant } from "./runner-types/EnvGrant";

export type { AppStateFrame as RunnerAppState } from "./runner-types/AppStateFrame";

export type { AutoDeploy as RunnerAutoDeploy } from "./runner-types/AutoDeploy";

export type { Environment as RunnerEnvironment } from "./runner-types/Environment";

export type { EnvironmentKind } from "./runner-types/EnvironmentKind";

export type { ErrorEventView as RunnerErrorEvent } from "./runner-types/ErrorEventView";

export type { ErrorIssueDetail as RunnerErrorDetail } from "./runner-types/ErrorIssueDetail";

export type { ErrorIssueList as RunnerErrorList } from "./runner-types/ErrorIssueList";

export type { ErrorIssueView as RunnerErrorIssue } from "./runner-types/ErrorIssueView";

export type { Frame as RunnerErrorFrame } from "./runner-types/Frame";

// The forge wire types, generated from host::forge and host::git_identity.
export type { Actor } from "./runner-types/Actor";

export type { BranchRules } from "./runner-types/BranchRules";

export type { GitBranch } from "./runner-types/GitBranch";

export type { GitCommitDetail } from "./runner-types/GitCommitDetail";

export type { GitCommitSummary } from "./runner-types/GitCommitSummary";

export type { GitCompare } from "./runner-types/GitCompare";

export type { GitFileStat } from "./runner-types/GitFileStat";

export type { GitFileStatus } from "./runner-types/GitFileStatus";

export type { GitLog } from "./runner-types/GitLog";

export type { GitRefs } from "./runner-types/GitRefs";

export type { GitRemote as RunnerGitRemote } from "./runner-types/GitRemote";

export type { IngestKeyView as RunnerIngestKey } from "./runner-types/IngestKeyView";

export type { LimitsView as RunnerLimits } from "./runner-types/LimitsView";

export type { PrComment } from "./runner-types/PrComment";

export type { PrCounts } from "./runner-types/PrCounts";

export type { PrDetail } from "./runner-types/PrDetail";

export type { PrList } from "./runner-types/PrList";

export type { PrReview } from "./runner-types/PrReview";

export type { PrSummary } from "./runner-types/PrSummary";

export type { R2File } from "./runner-types/R2File";

export type { R2Folder } from "./runner-types/R2Folder";

export type { R2Object } from "./runner-types/R2Object";

export type { R2Preview } from "./runner-types/R2Preview";

export type { SourceCommitBody } from "./runner-types/SourceCommitBody";

export type { SourceCommitFile } from "./runner-types/SourceCommitFile";

export type { SourceCommitMove } from "./runner-types/SourceCommitMove";

export type { StorageItem } from "./runner-types/StorageItem";

export type { TelemetryEvent as RunnerTelemetryEvent } from "./runner-types/TelemetryEvent";

export type { TelemetryStatus as RunnerTelemetryStatus } from "./runner-types/TelemetryStatus";

export type { TreeEntry } from "./runner-types/TreeEntry";

export type { TreeResponse as RunnerTree } from "./runner-types/TreeResponse";

export type { UpdateStatus as RunnerUpdateStatus } from "./runner-types/UpdateStatus";

const readEnv = (): KitEnv => {
  hydrateControlEnv();

  const merged = {
    ...controlEnv,
    ...(typeof process === "undefined" ? undefined : process.env),
  };

  // SAFETY: merged carries the union of controlEnv defaults (stamped per request by the middleware) and process.env — all keyed by the same env names KitEnv declares; unset string keys are left undefined which callers already tolerate.
  return merged as KitEnv;
};

/** The runner beside this worker: the control fleet (prod) and `vite dev`
 * (dev) both run in the runner's container. */
export const RUNNER_DEFAULT_URL = "http://127.0.0.1:8080";

/** Runner base URL from the environment. */
const runnerBase = () =>
  (readEnv().RUNNER_URL ?? RUNNER_DEFAULT_URL).replace(/\/$/u, "");

/** Stamp the platform env for runner calls made outside an endpoint handler.
 * The middleware stamps every request, so a plain route handler —
 * `/internal/git-auth`, the SSE pollers — otherwise sees the
 * localhost-family dev defaults and misses the real RUNNER_URL/RUNNER_TOKEN. */
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

/** A JSON-RPC error from the runner, with its numeric code kept on the
 * error instead of only inside the message: envelope ingest tells a wrong
 * key from a transport failure by matching `code`, never message text. */
export class RunnerRpcError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(method: string, code: number, message: string) {
    super(`runner rpc ${method}: ${code} ${message}`);
    this.name = "RunnerRpcError";
    this.code = code;
    this.method = method;
  }
}

/** A non-ok HTTP answer from the runner, kept typed so callers never parse
 * the message for the status. */
export class RunnerHttpError extends Error {
  readonly body: string;
  readonly path: string;
  readonly status: number;

  constructor(path: string, status: number, body: string) {
    // The body stays in the field only: this message reaches `failUnknown`
    // and therefore a client, and an upstream body is not ours to forward.
    super(`runner ${path}: ${status}`);
    this.name = "RunnerHttpError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/** Every way a runner call fails, as one closed type. `runnerFailureOf` is
 * the only classifier: callers branch on this, never on `error.name` or on
 * English text. */
export type RunnerFailure =
  | { readonly kind: "http"; readonly path: string; readonly status: number }
  | { readonly kind: "rpc"; readonly code: number; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string };

/** Classify a caught runner error. `runnerFetch`/`runnerRpc` already threw a
 * typed error for an RPC rejection or a non-ok answer; a fetch-level throw is
 * a timeout when it is the abort signal's, otherwise unreachable. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site classifier: the thrown value is unknown by construction, and this is the one place it becomes a domain type.
export const runnerFailureOf = (error: unknown): RunnerFailure => {
  if (error instanceof RunnerRpcError) {
    return { code: error.code, kind: "rpc", message: error.message };
  }

  if (error instanceof RunnerHttpError) {
    return { kind: "http", path: error.path, status: error.status };
  }

  const message = errorMessage(error);

  return error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
    ? { kind: "timeout", message }
    : { kind: "unreachable", message };
};

/** A create conflict for a slug that already exists. The runner answers 409
 * with this message (there is no machine-readable sub-code yet), so this is
 * the one place the control UI names it. */
export const isSlugTaken = (failure: RunnerFailure): boolean =>
  failure.kind === "rpc" &&
  failure.code === 409 &&
  failure.message.includes("slug already taken");

/** The account's app limit, from the runner's 409 text (see `isSlugTaken`). */
export const isAppLimitReached = (failure: RunnerFailure): boolean =>
  failure.kind === "rpc" &&
  failure.code === 409 &&
  failure.message.includes("app limit reached");

/** The runner's error text without the RPC envelope. */
export const runnerFailureMessage = (failure: RunnerFailure): string => {
  switch (failure.kind) {
    case "http": {
      return `runner ${failure.path}: ${failure.status}`;
    }

    case "rpc":
    case "timeout":
    case "unreachable": {
      return failure.message;
    }

    default: {
      return "runner call failed";
    }
  }
};

interface JsonRpcEnvelope<T> {
  error?: { code: number; message: string };
  id: number;
  jsonrpc: string;
  result?: T;
}

/** Bound every runner call: a hung upstream must fail with the path in the
 * message, never hang into the platform request deadline. Healthy calls
 * measure ~70ms through the public edge (a Railway worker cell cannot resolve
 * `*.railway.internal`, so that hop is the internet), so 5s leaves room for
 * the slow queries (logs and errors read SQLite rings) while still failing well
 * before a browser gives up — a 10s bound surfaced as a mystery hang. */
const RUNNER_TIMEOUT_MS = 5000;

/** Create, rename and delete bound themselves: a create clears a deleted
 * slug's leftovers, a rename moves a whole S3 prefix, and a delete stops a
 * fleet before purging. They still answer promptly (delete within 3 s) — the
 * longer abort only covers those lifecycle moves on a slow store. Kept under
 * the control UI's 15 s route bound (`middleware/01-timeout.ts`): past it the
 * route answers a 504 and the runner fetch is abandoned anyway. */
const LIFECYCLE_TIMEOUT_MS = 14_000;

/** Create's own bound, shorter than {@link LIFECYCLE_TIMEOUT_MS}: a create
 * that outlives it is recovered by `adoptSlowCreate`, so create plus adopt
 * must fit inside the route bound. 8 s + a 4 s adopt poll + the grant and the
 * response stay under 15 s; with the 14 s lifecycle bound the adopt could
 * never run inside the route's life. */
export const CREATE_TIMEOUT_MS = 8000;

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
    throw new RunnerHttpError(
      `${init.method ?? "GET"} ${path}`,
      res.status,
      text
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

let rpcId = 0;

export const runnerRpc = async <T = unknown>(
  method: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- params differ per method; the server parses per-method and rejects mismatches with InvalidParams.
  params: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<T> => {
  rpcId += 1;

  const payload = await runnerFetch<JsonRpcEnvelope<T>>("/rpc", {
    body: JSON.stringify({ id: rpcId, jsonrpc: "2.0", method, params }),
    method: "POST",
    // Lifecycle mutations may move a whole S3 prefix (rename) or clear a
    // deleted slug's leftovers (create); the runner bounds them itself, but
    // the default 5 s abort would surface as "operation aborted due to
    // timeout" while the runner is still working.
    signal:
      options?.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(options.timeoutMs),
  });

  if (payload.error) {
    throw new RunnerRpcError(method, payload.error.code, payload.error.message);
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

/** Opt-out update check: effective + stored state, the lock, the running
 * version and the newest release seen. */
export const runnerUpdateGet = () =>
  runnerRpc<RunnerUpdateStatus>("instance.update_status", {});

/** Store the opt-out preference; returns the same status shape. Enabling
 * runs one immediate check, so the banner can appear without waiting for
 * the next hourly tick; a failed fetch keeps the last result. */
export const runnerUpdateSet = (enabled: boolean) =>
  runnerRpc<RunnerUpdateStatus>("instance.update_set", { enabled });

export const runnerListApps = () => runnerRpc<RunnerApp[]>("apps.list", {});

/** Where a new app's content comes from, as the runner's `apps.create` takes
 * it (A2/A3). `blank` is the empty repo. A `git` source is the one the runner
 * allowlists to `https://github.com/<owner>/<repo>` and imports in the
 * background; `squash` collapses a template's history into one initial commit
 * authored as `actor`. */
export type RunnerCreateSource =
  | { kind: "blank" }
  | {
      actor: { name: string; userId: string };
      kind: "git";
      /** Import only this subdirectory (a monorepo package), squashed. */
      path?: string;
      ref?: string;
      squash?: boolean;
      url: string;
    };

export const runnerCreateApp = (body: {
  name: string;
  slug: string;
  source?: RunnerCreateSource;
  userId: string;
}) =>
  runnerRpc<RunnerApp>(
    "apps.create",
    {
      name: body.name,
      slug: body.slug,
      // `source` is camelCase JSON (undefined keys never reach the wire), the
      // rest of the params are snake_case.
      source: body.source,
      user_id: body.userId,
    },
    { timeoutMs: CREATE_TIMEOUT_MS }
  );

/** Retry the import an app was created from (A2): only meaningful when its
 * stored source is an import and it is not already running. */
export const runnerRetryImport = (id: string) =>
  runnerRpc<RunnerApp>("apps.retry_import", { id });

export const runnerGetApp = (id: string) =>
  runnerRpc<RunnerApp>("apps.get", { id });

export const runnerGetAppBySlug = (slug: string, timeoutMs?: number) =>
  runnerRpc<RunnerApp>(
    "apps.get_by_slug",
    { slug },
    timeoutMs === undefined ? undefined : { timeoutMs }
  );

// `apps.patch` takes camelCase params (like the REST PATCH body), unlike most
// RPC methods; the runner rejects unknown keys so a mismatch fails loudly.
export const runnerPatchApp = (id: string, body: { desiredState: string }) =>
  runnerRpc<RunnerApp>("apps.patch", { desiredState: body.desiredState, id });

/** `deleting: true` when the purge still runs in the background (a slow
 * store, a deploy holding the app): the runner answers within its 3 s bound
 * either way, and the app is gone from every listing from the start. */
export const runnerDeleteApp = (id: string) =>
  runnerRpc<{ deleting: boolean; ok: boolean }>(
    "apps.delete",
    { id },
    { timeoutMs: LIFECYCLE_TIMEOUT_MS }
  );

export const runnerRenameApp = (
  id: string,
  body: { name?: string; slug?: string }
) =>
  runnerRpc<RunnerApp>(
    "apps.rename",
    { id, ...body },
    { timeoutMs: LIFECYCLE_TIMEOUT_MS }
  );

export const runnerDeployLog = (id: string, deployId: string) =>
  runnerRpc<{ log: string }>("deploys.log", { deploy_id: deployId, id });

/** Stop an in-flight deploy (its row closes with the operator's line). */
export const runnerCancelDeploy = (id: string, deployId: string) =>
  runnerRpc<{ ok: boolean }>("deploys.cancel", { deploy_id: deployId, id });

/** Re-run an old sha: production, or one preview environment (`""`/absent is
 * production; the runner proves the sha was successful *in that target* and,
 * for a preview, that the caller may push). */
export const runnerRollback = (
  id: string,
  sha: string,
  environmentId = "",
  role = ""
) =>
  runnerRpc<{ deployId: string; ok: boolean; sha: string }>(
    "deploys.rollback",
    {
      environment_id: environmentId === "" ? undefined : environmentId,
      id,
      role: role === "" ? undefined : role,
      sha,
    }
  );

/** Deploy one branch's current tip to production once (the UI's Deploy
 * button with another branch picked); the production branch itself is
 * untouched. */
export const runnerDeployBranch = (id: string, ref: string, role = "") =>
  runnerRpc<{ deployId: string; ok: boolean; sha: string }>("deploys.deploy", {
    id,
    ref,
    role: role === "" ? undefined : role,
  });

/** Deploy history, optionally in one preview environment (absent/"" is
 * production): the initial snapshot behind the live Deployments list. */
export const runnerListDeploys = (id: string, environmentId = "") =>
  runnerRpc<RunnerDeploy[]>("deploys.list", {
    environmentId: environmentId === "" ? undefined : environmentId,
    id,
  });

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

export const runnerGetError = (
  id: string,
  fingerprint: string,
  environmentId = ""
) =>
  runnerRpc<RunnerErrorDetail>("errors.get", {
    environmentId: environmentId === "" ? undefined : environmentId,
    fingerprint,
    id,
  });

export const runnerSetErrorStatus = (
  id: string,
  fingerprint: string,
  status: ErrorStatus,
  environmentId = ""
) =>
  runnerRpc<{ ok: boolean }>("errors.set_status", {
    environmentId: environmentId === "" ? undefined : environmentId,
    fingerprint,
    id,
    status,
  });

/** One status's issue list, optionally in one preview environment
 * (absent/"" is production): the initial snapshot behind the live Errors
 * tab. Same shape as the stream frame. */
export const runnerListErrors = (
  id: string,
  status: ErrorStatus,
  environmentId = ""
) =>
  runnerRpc<RunnerErrorList>("errors.list", {
    environmentId: environmentId === "" ? undefined : environmentId,
    id,
    status,
  });

/** Event feed rows for one channel, optionally in one preview environment
 * (absent/"" is production). */
export const runnerListEvents = (
  id: string,
  channel: string,
  limit: number,
  environmentId = ""
) =>
  runnerRpc<RunnerEvent[]>("events.list", {
    channel: channel === "" ? undefined : channel,
    environmentId: environmentId === "" ? undefined : environmentId,
    id,
    limit,
  });

/** Channel names with events, optionally in one preview environment
 * (absent/"" is production). */
export const runnerListEventChannels = (id: string, environmentId = "") =>
  runnerRpc<string[]>("events.channels", {
    environmentId: environmentId === "" ? undefined : environmentId,
    id,
  });

/** Insight widgets, optionally in one preview environment (absent/"" is
 * production). */
export const runnerListEventInsights = (id: string, environmentId = "") =>
  runnerRpc<RunnerInsight[]>("events.insights", {
    environmentId: environmentId === "" ? undefined : environmentId,
    id,
  });

/** Merged log tail (ingested ring plus the fleet's live stdout), oldest
 * first — the initial snapshot behind the live Logs tail. */
export const runnerGetLogs = (id: string, environmentId = "") =>
  runnerRpc<string[]>("logs.get", {
    environmentId: environmentId === "" ? undefined : environmentId,
    id,
  });

/** The app's public error-ingest identity (numeric project id + key). The
 * runner mints the row on first view; `role` is the caller's resolved app
 * role, enforced runner-side. */
export const runnerGetIngestKey = (id: string, role: string) =>
  runnerRpc<RunnerIngestKey>("errors.ingest_key", { id, role });

/** Mint a replacement ingest key, keeping the numeric project id. Admin. */
export const runnerRotateIngestKey = (id: string, role: string) =>
  runnerRpc<RunnerIngestKey>("errors.rotate_ingest_key", { id, role });

/** Record one envelope's events under the app the project number resolves
 * to. A wrong key or unknown number fails with a 404-code RunnerRpcError;
 * callers map that to one refusal that reveals neither. */
export const runnerIngestErrors = (
  projectId: number,
  key: string,
  events: SentryEventItem[]
) =>
  runnerRpc<{ fingerprints: string[] }>("errors.ingest", {
    events,
    key,
    projectId,
  });

/** Custom hostnames attached to an app (all of them, in hostname order).
 * `role` is the caller's resolved app role, enforced runner-side. */
export const runnerListDomains = (id: string, role: string) =>
  runnerRpc<RunnerDomain[]>("domains.list", { id, role });

/** Reserve a hostname. The runner validates the shape and rejects a hostname
 * the platform owns or another app already holds. In `multi` tenancy the
 * claim starts pending until its TXT proof verifies; in `single` it is
 * verified immediately. */
export const runnerAddDomain = (id: string, hostname: string, role: string) =>
  runnerRpc<RunnerDomain[]>("domains.add", { hostname, id, role });

/** Check this app's pending claim: the TXT record at
 * `_noite-challenge.<hostname>` must contain the claim's token. */
export const runnerVerifyDomain = (
  id: string,
  hostname: string,
  role: string
) => runnerRpc<RunnerDomain[]>("domains.verify", { hostname, id, role });

export const runnerRemoveDomain = (
  id: string,
  hostname: string,
  role: string
) => runnerRpc<RunnerDomain[]>("domains.remove", { hostname, id, role });

export const runnerGetLimits = (id: string) =>
  runnerRpc<RunnerLimits>("limits.get", { id });

/** Replace the limits; null returns one to the platform default. */
export const runnerSetLimits = (
  id: string,
  clientRpm: number | null,
  appRpm: number | null,
  memoryMb: number | null,
  sleepAfterS: number | null,
  role: string
) =>
  runnerRpc<RunnerLimits>("limits.set", {
    appRpm,
    clientRpm,
    id,
    memoryMb,
    role,
    sleepAfterS,
  });

export const runnerGitRemote = (id: string) =>
  runnerRpc<RunnerGitRemote>("git.remote", { id });

/** Branch tips with distance from `main`, plus the deployed sha. */
export const runnerGitRefs = (id: string) =>
  runnerRpc<GitRefs>("git.refs", { id });

/** One page of history; `ref` defaults to `main`, `limit` to 50 (1..100). */
export const runnerGitLog = (
  id: string,
  query: { ref?: string; path?: string; skip?: number; limit?: number } = {}
) => runnerRpc<GitLog>("git.log", { id, ...query });

/** One commit: metadata, body, per-file stats and the patch against its
 * first parent (or the empty tree for a root commit). */
export const runnerGitCommit = (id: string, sha: string) =>
  runnerRpc<GitCommitDetail>("git.commit", { id, sha });

/** `base..head` commits, the three-dot diff, and whether a squash merge
 * would land cleanly. */
export const runnerGitCompare = (id: string, base: string, head: string) =>
  runnerRpc<GitCompare>("git.compare", { base, head, id });

/** Create a branch at `from` (a ref or sha); 409 when it exists. */
export const runnerGitBranchCreate = (id: string, name: string, from: string) =>
  runnerRpc<GitBranch>("git.branch_create", { from, id, name });

/** Delete a branch; `main` is refused. */
export const runnerGitBranchDelete = (id: string, name: string) =>
  runnerRpc<{ ok: boolean }>("git.branch_delete", { id, name });

// Pull requests (F4). `actor` is `{userId, name}`; `role` is the caller's app
// role, computed by the UI action and trusted by the runner for policy.

export const runnerPrsList = (
  id: string,
  query: { state?: string; skip?: number; limit?: number } = {}
) => runnerRpc<PrList>("prs.list", { id, ...query });

export const runnerPrGet = (id: string, number: number) =>
  runnerRpc<PrDetail>("prs.get", { id, number });

export const runnerPrCreate = (
  id: string,
  body: {
    actor: { name: string; userId: string };
    /** How a machine signs the pull request; absent for a person. */
    authorLabel?: string;
    base: string;
    body?: string;
    head: string;
    title: string;
  }
) => runnerRpc<PrDetail>("prs.create", { id, ...body });

export const runnerPrUpdate = (
  id: string,
  number: number,
  body: {
    actor: { name: string; userId: string };
    body?: string;
    role: string;
    state?: string;
    title?: string;
  }
) => runnerRpc<PrDetail>("prs.update", { id, number, ...body });

export const runnerPrComment = (
  id: string,
  number: number,
  body: {
    actor: { name: string; userId: string };
    /** How a machine signs the comment; absent for a person. */
    authorLabel?: string;
    body: string;
    commitSha?: string;
    line?: number;
    path?: string;
    role: string;
    side?: string;
  }
) => runnerRpc<PrComment>("prs.comment", { id, number, ...body });

export const runnerPrCommentEdit = (
  id: string,
  commentId: string,
  body: { actor: { name: string; userId: string }; body: string }
) =>
  runnerRpc<{ ok: boolean }>("prs.comment_edit", {
    actor: body.actor,
    body: body.body,
    commentId,
    id,
  });

export const runnerPrCommentDelete = (
  id: string,
  commentId: string,
  body: { actor: { name: string; userId: string }; role: string }
) =>
  runnerRpc<{ ok: boolean }>("prs.comment_delete", {
    commentId,
    id,
    ...body,
  });

export const runnerPrReview = (
  id: string,
  number: number,
  body: {
    actor: { name: string; userId: string };
    /** How a machine signs the review; absent for a person. */
    authorLabel?: string;
    role: string;
    state: "approved" | "changes_requested";
  }
) => runnerRpc<PrDetail>("prs.review", { id, number, ...body });

export const runnerPrMerge = (
  id: string,
  number: number,
  body: {
    actor: { name: string; userId: string };
    authorName?: string;
    deleteBranch?: boolean;
    message?: string;
    role: string;
    title?: string;
  }
) => runnerRpc<PrDetail>("prs.merge", { id, number, ...body });

export const runnerBranchRulesGet = (id: string) =>
  runnerRpc<BranchRules>("branch_rules.get", { id });

export const runnerBranchRulesSet = (
  id: string,
  body: { requirePr: boolean; requiredApprovals: number }
) => runnerRpc<BranchRules>("branch_rules.set", { id, ...body });

// RunnerTree/Blob are generated from host::source::{TreeResponse,
// BlobResponse}. `ref` (branch, tag or sha) selects what to browse; absent
// keeps the deployed-sha resolution.

export const runnerSourceTree = (id: string, ref?: string) =>
  runnerRpc<RunnerTree>("source.tree", { id, ref });

export const runnerSourceBlob = (id: string, path: string, ref?: string) =>
  runnerRpc<RunnerBlob>("source.blob", { id, path, ref });

/** Commit source edits server-side (the MCP `commit_files` path): the same
 * runner endpoint the control route forwards a browser's body to, so both
 * surfaces make the identical commit and answer `{ sha }`. The runner is the
 * authority on paths, sizes and encodings. */
export const runnerSourceCommit = (id: string, body: SourceCommitBody) =>
  runnerFetch<{ sha: string }>(
    `/v1/apps/${encodeURIComponent(id)}/source/commit`,
    {
      body: JSON.stringify(body),
      method: "POST",
      signal: AbortSignal.timeout(SOURCE_FORWARD_TIMEOUT_MS),
    }
  );

// Preview environments (ROADMAP: Preview environments). The runner enforces
// the app role on every call, so the UI resolves the caller's role and passes
// it: `view` to read, `push` to create/deploy and set variables, `admin` to
// delete and to flip an environment public. `main` is never an environment.

export const runnerEnvironmentsList = (id: string, role: string) =>
  runnerRpc<RunnerEnvironment[]>("environments.list", { id, role });

/** Create the branch's environment (using `label`, no override) and deploy its
 * head; `actor` names the creator. */
export const runnerEnvironmentCreate = (
  id: string,
  branch: string,
  role: string,
  actor?: SourceCommitBody["actor"]
) =>
  runnerRpc<RunnerEnvironment>("environments.create", {
    actor,
    branch,
    id,
    role,
  });

export const runnerEnvironmentDelete = async (
  id: string,
  envId: string,
  role: string
): Promise<void> => {
  await runnerRpc<{ ok: boolean }>("environments.delete", { envId, id, role });
};

export const runnerEnvironmentUpdate = (
  id: string,
  envId: string,
  isPublic: boolean,
  role: string
) =>
  runnerRpc<RunnerEnvironment>("environments.update", {
    envId,
    id,
    public: isPublic,
    role,
  });

/** Re-deploy one environment. `actor` is who asked, when the caller can say
 * (a profile API key's attributable label); the deploy row keeps it. */
export const runnerEnvironmentDeploy = (
  id: string,
  envId: string,
  role: string,
  actor?: string
) => {
  const params =
    actor === undefined ? { envId, id, role } : { actor, envId, id, role };

  return runnerRpc<{ deployId: string; sha: string }>(
    "environments.deploy",
    params
  );
};

/** One environment's variable overrides (raw rows: the caller redacts). */
export const runnerEnvironmentVars = (
  id: string,
  envId: string,
  role: string
) => runnerRpc<RunnerEnv[]>("environments.vars.get", { envId, id, role });

export const runnerEnvironmentVarSet = (
  id: string,
  envId: string,
  name: string,
  value: string,
  role: string
) =>
  runnerRpc<{ ok: boolean; name: string }>("environments.vars.set", {
    envId,
    id,
    name,
    role,
    value,
  });

export const runnerEnvironmentVarDelete = async (
  id: string,
  envId: string,
  name: string,
  role: string
): Promise<void> => {
  await runnerRpc<{ ok: boolean }>("environments.vars.delete", {
    envId,
    id,
    name,
    role,
  });
};

/** Mint the short-lived hand-back token the control UI's `/api/env-auth` route
 * redirects a browser with (the runner has no session; this is what turns
 * "this viewer may see this environment" into a token). */
export const runnerEnvironmentGrant = (
  id: string,
  envId: string,
  userId: string
) => runnerRpc<EnvGrant>("environments.grant", { envId, id, userId });

// RunnerMetric/Span/Device/Path/Ref/Event/UserProps/Insight are generated
// from the models::App*Stat rows, models::AppEvent, AppUserProps and
// AppInsight.

export const runnerGetUserProps = (
  id: string,
  userId: string,
  environmentId = ""
) =>
  runnerRpc<RunnerUserProps | null>("events.user_props", {
    environmentId: environmentId === "" ? undefined : environmentId,
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
