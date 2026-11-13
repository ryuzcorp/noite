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

/** What a non-ok runner answer reads as. `ApiError` answers the message it
 * means the caller to read; an interposed proxy answers HTML, which is never
 * ours to forward. */
const runnerTextFor = (path: string, status: number, body: string): string => {
  const text = body.trim();

  return text === "" || text.startsWith("<")
    ? `runner ${path}: ${status}`
    : text;
};

/** A non-ok HTTP answer from the runner, kept typed so callers never parse
 * the message for the status. */
export class RunnerHttpError extends Error {
  readonly body: string;
  readonly path: string;
  readonly status: number;

  constructor(path: string, status: number, body: string) {
    // The raw body stays on the field; only the runner's own plain-text
    // message becomes the error text, because `failUnknown` shows this
    // message to a client.
    super(runnerTextFor(path, status, body));
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
  | {
      readonly kind: "http";
      readonly message: string;
      readonly path: string;
      readonly status: number;
    }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string };

/** Classify a caught runner error. `runnerFetch` already threw a typed error
 * for a non-ok answer; a fetch-level throw is a timeout when it is the abort
 * signal's, otherwise unreachable. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site classifier: the thrown value is unknown by construction, and this is the one place it becomes a domain type.
export const runnerFailureOf = (error: unknown): RunnerFailure => {
  if (error instanceof RunnerHttpError) {
    return {
      kind: "http",
      message: error.message,
      path: error.path,
      status: error.status,
    };
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
  failure.kind === "http" &&
  failure.status === 409 &&
  failure.message.includes("slug already taken");

/** The account's app limit, from the runner's 409 text (see `isSlugTaken`). */
export const isAppLimitReached = (failure: RunnerFailure): boolean =>
  failure.kind === "http" &&
  failure.status === 409 &&
  failure.message.includes("app limit reached");

/** The runner's error text for a failure, status included for a bare one. */
export const runnerFailureMessage = (failure: RunnerFailure): string => {
  switch (failure.kind) {
    case "http":
    case "timeout":
    case "unreachable": {
      return failure.message;
    }

    default: {
      return "runner call failed";
    }
  }
};

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

/** Path of one app's resource. */
const appPath = (id: string): string => `/v1/apps/${encodeURIComponent(id)}`;

/** `?a=b&c=d` from present values: `undefined` and `""` both mean "the
 * platform default" (production logs, every channel, the deployed sha). */
const query = (params: Record<string, number | string | undefined>): string => {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }

  const encoded = search.toString();

  return encoded === "" ? "" : `?${encoded}`;
};

/** One wildcard tail (`a/b/c` keeps its slashes) with every segment encoded,
 * for a branch name, a file path or a hostname in a route. */
const pathTail = (value: string): string =>
  value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

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
  runnerFetch<RunnerTelemetryStatus>("/v1/admin/telemetry");

/** Store the opt-out preference; returns the same status shape. While the
 * setting is locked the preference is stored but effective stays disabled. */
export const runnerTelemetrySet = (enabled: boolean) =>
  runnerFetch<RunnerTelemetryStatus>("/v1/admin/telemetry", {
    body: JSON.stringify({ enabled }),
    method: "PUT",
  });

/** Opt-out update check: effective + stored state, the lock, the running
 * version and the newest release seen. */
export const runnerUpdateGet = () =>
  runnerFetch<RunnerUpdateStatus>("/v1/admin/update");

/** Store the opt-out preference; returns the same status shape. Enabling
 * runs one immediate check, so the banner can appear without waiting for
 * the next hourly tick; a failed fetch keeps the last result. */
export const runnerUpdateSet = (enabled: boolean) =>
  runnerFetch<RunnerUpdateStatus>("/v1/admin/update", {
    body: JSON.stringify({ enabled }),
    method: "PUT",
  });

export const runnerListApps = () => runnerFetch<RunnerApp[]>("/v1/apps");

/** Where a new app's content comes from, as the runner's app create takes
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
  runnerFetch<RunnerApp>("/v1/apps", {
    body: JSON.stringify({
      name: body.name,
      slug: body.slug,
      source: body.source,
      userId: body.userId,
    }),
    method: "POST",
    // Lifecycle mutations may move a whole S3 prefix (rename) or clear a
    // deleted slug's leftovers (create); the runner bounds them itself, but
    // the default 5 s abort would surface as "operation aborted due to
    // timeout" while the runner is still working.
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });

/** Retry the import an app was created from (A2): only meaningful when its
 * stored source is an import and it is not already running. */
export const runnerRetryImport = (id: string) =>
  runnerFetch<RunnerApp>(`${appPath(id)}/retry-import`, { method: "POST" });

export const runnerGetApp = (id: string) => runnerFetch<RunnerApp>(appPath(id));

export const runnerGetAppBySlug = (slug: string, timeoutMs?: number) =>
  runnerFetch<RunnerApp>(`/v1/apps/by-slug/${encodeURIComponent(slug)}`, {
    signal:
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  });

export const runnerPatchApp = (id: string, body: { desiredState: string }) =>
  runnerFetch<RunnerApp>(appPath(id), {
    body: JSON.stringify({ desiredState: body.desiredState }),
    method: "PATCH",
  });

/** `deleting: true` when the purge still runs in the background (a slow
 * store, a deploy holding the app): the runner answers within its 3 s bound
 * either way, and the app is gone from every listing from the start. */
export const runnerDeleteApp = async (id: string) => {
  // 204 once the purge finished, 202 `{ deleting: true }` while it runs.
  const result = await runnerFetch<{ deleting?: boolean } | undefined>(
    appPath(id),
    {
      method: "DELETE",
      signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
    }
  );

  return { deleting: result?.deleting === true, ok: true as const };
};

export const runnerRenameApp = (
  id: string,
  body: { name?: string; slug?: string }
) =>
  runnerFetch<RunnerApp>(`${appPath(id)}/rename`, {
    body: JSON.stringify({
      name: body.name,
      slug: body.slug,
    }),
    method: "POST",
    signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
  });

export const runnerDeployLog = (id: string, deployId: string) =>
  runnerFetch<{ log: string }>(
    `${appPath(id)}/deploys/${encodeURIComponent(deployId)}/log`
  );

/** Stop an in-flight deploy (its row closes with the operator's line). */
export const runnerCancelDeploy = (id: string, deployId: string) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/deploys/${encodeURIComponent(deployId)}/cancel`,
    { method: "POST" }
  );

/** Re-run an old sha: production, or one preview environment (`""`/absent is
 * production; the runner proves the sha was successful *in that target* and,
 * for a preview, that the caller may push). */
export const runnerRollback = (
  id: string,
  sha: string,
  environmentId = "",
  role = ""
) =>
  runnerFetch<{ deployId: string; ok: boolean; sha: string }>(
    `${appPath(id)}/rollback${query({ role })}`,
    {
      body: JSON.stringify({
        environmentId: environmentId === "" ? undefined : environmentId,
        sha,
      }),
      method: "POST",
    }
  );

/** Deploy one branch's current tip to production once (the UI's Deploy
 * button with another branch picked); the production branch itself is
 * untouched. */
export const runnerDeployBranch = (id: string, ref: string, role = "") =>
  runnerFetch<{ deployId: string; ok: boolean; sha: string }>(
    `${appPath(id)}/deploy${query({ role })}`,
    {
      body: JSON.stringify({ ref }),
      method: "POST",
    }
  );

/** Deploy history, optionally in one preview environment (absent/"" is
 * production): the initial snapshot behind the live Deployments list. */
export const runnerListDeploys = (id: string, environmentId = "") =>
  runnerFetch<RunnerDeploy[]>(
    `${appPath(id)}/deploys${query({ environmentId })}`
  );

export const runnerListEnv = (id: string) =>
  runnerFetch<RunnerEnv[]>(`${appPath(id)}/env`);

export const runnerSetEnv = (id: string, name: string, value: string) =>
  runnerFetch<{ ok: boolean; name: string }>(`${appPath(id)}/env`, {
    body: JSON.stringify({ name, value }),
    method: "POST",
  });

export const runnerDeleteEnv = (id: string, name: string) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/env/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );

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
  runnerFetch<RunnerErrorDetail>(
    `${appPath(id)}/errors/${encodeURIComponent(fingerprint)}${query({
      environmentId,
    })}`
  );

export const runnerSetErrorStatus = (
  id: string,
  fingerprint: string,
  status: ErrorStatus,
  environmentId = ""
) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/errors/${encodeURIComponent(fingerprint)}`,
    {
      body: JSON.stringify({
        environmentId: environmentId === "" ? undefined : environmentId,
        status,
      }),
      method: "PATCH",
    }
  );

/** One status's issue list, optionally in one preview environment
 * (absent/"" is production): the initial snapshot behind the live Errors
 * tab. Same shape as the stream frame. */
export const runnerListErrors = (
  id: string,
  status: ErrorStatus,
  environmentId = ""
) =>
  runnerFetch<RunnerErrorList>(
    `${appPath(id)}/errors${query({ environmentId, status })}`
  );

/** Event feed rows for one channel, optionally in one preview environment
 * (absent/"" is production). */
export const runnerListEvents = (
  id: string,
  channel: string,
  limit: number,
  environmentId = ""
) =>
  runnerFetch<RunnerEvent[]>(
    `${appPath(id)}/events${query({ channel, environmentId, limit })}`
  );

/** Channel names with events, optionally in one preview environment
 * (absent/"" is production). */
export const runnerListEventChannels = (id: string, environmentId = "") =>
  runnerFetch<string[]>(
    `${appPath(id)}/events/channels${query({ environmentId })}`
  );

/** Insight widgets, optionally in one preview environment (absent/"" is
 * production). */
export const runnerListEventInsights = (id: string, environmentId = "") =>
  runnerFetch<RunnerInsight[]>(
    `${appPath(id)}/insights${query({ environmentId })}`
  );

/** Merged log tail (ingested ring plus the fleet's live stdout), oldest
 * first — the initial snapshot behind the live Logs tail. */
export const runnerGetLogs = (id: string, environmentId = "") =>
  runnerFetch<string[]>(`${appPath(id)}/logs${query({ environmentId })}`);

/** The app's public error-ingest identity (numeric project id + key). The
 * runner mints the row on first view; `role` is the caller's resolved app
 * role, enforced runner-side. */
export const runnerGetIngestKey = (id: string, role: string) =>
  runnerFetch<RunnerIngestKey>(
    `${appPath(id)}/errors/ingest-key${query({ role })}`
  );

/** Mint a replacement ingest key, keeping the numeric project id. Admin. */
export const runnerRotateIngestKey = (id: string, role: string) =>
  runnerFetch<RunnerIngestKey>(
    `${appPath(id)}/errors/ingest-key/rotate${query({ role })}`,
    { method: "POST" }
  );

/** Record one envelope's events under the app the project number resolves
 * to. A wrong key or unknown number fails with a 404 runner error; callers
 * map that to one refusal that reveals neither. */
export const runnerIngestErrors = (
  projectId: number,
  key: string,
  events: SentryEventItem[]
) =>
  runnerFetch<{ fingerprints: string[] }>("/v1/errors/ingest", {
    body: JSON.stringify({ events, key, projectId }),
    method: "POST",
  });

/** Custom hostnames attached to an app (all of them, in hostname order).
 * `role` is the caller's resolved app role, enforced runner-side. */
export const runnerListDomains = (id: string, role: string) =>
  runnerFetch<RunnerDomain[]>(`${appPath(id)}/domains${query({ role })}`);

/** Reserve a hostname. The runner validates the shape and rejects a hostname
 * the platform owns or another app already holds. In `multi` tenancy the
 * claim starts pending until its TXT proof verifies; in `single` it is
 * verified immediately. */
export const runnerAddDomain = (id: string, hostname: string, role: string) =>
  runnerFetch<RunnerDomain[]>(`${appPath(id)}/domains${query({ role })}`, {
    body: JSON.stringify({ hostname }),
    method: "POST",
  });

/** Check this app's pending claim: the TXT record at
 * `_noite-challenge.<hostname>` must contain the claim's token. */
export const runnerVerifyDomain = (
  id: string,
  hostname: string,
  role: string
) =>
  runnerFetch<RunnerDomain[]>(
    `${appPath(id)}/domains/verify${query({ role })}`,
    {
      body: JSON.stringify({ hostname }),
      method: "POST",
    }
  );

export const runnerRemoveDomain = (
  id: string,
  hostname: string,
  role: string
) =>
  runnerFetch<RunnerDomain[]>(
    `${appPath(id)}/domains/${encodeURIComponent(hostname)}${query({ role })}`,
    { method: "DELETE" }
  );

export const runnerGetLimits = (id: string) =>
  runnerFetch<RunnerLimits>(`${appPath(id)}/limits`);

/** Replace the limits; null returns one to the platform default. */
export const runnerSetLimits = (
  id: string,
  clientRpm: number | null,
  appRpm: number | null,
  memoryMb: number | null,
  sleepAfterS: number | null,
  role: string
) =>
  runnerFetch<RunnerLimits>(`${appPath(id)}/limits`, {
    body: JSON.stringify({
      appRpm,
      clientRpm,
      memoryMb,
      role,
      sleepAfterS,
    }),
    method: "PUT",
  });

export const runnerGitRemote = (id: string) =>
  runnerFetch<RunnerGitRemote>(`${appPath(id)}/git-remote`, {
    method: "POST",
  });

/** Branch tips with distance from `main`, plus the deployed sha. */
export const runnerGitRefs = (id: string) =>
  runnerFetch<GitRefs>(`${appPath(id)}/git/refs`);

/** One page of history; `ref` defaults to `main`, `limit` to 50 (1..100). */
export const runnerGitLog = (
  id: string,
  params: { ref?: string; path?: string; skip?: number; limit?: number } = {}
) =>
  runnerFetch<GitLog>(
    `${appPath(id)}/git/log${query({
      limit: params.limit,
      path: params.path,
      ref: params.ref,
      skip: params.skip,
    })}`
  );

/** One commit: metadata, body, per-file stats and the patch against its
 * first parent (or the empty tree for a root commit). */
export const runnerGitCommit = (id: string, sha: string) =>
  runnerFetch<GitCommitDetail>(
    `${appPath(id)}/git/commits/${encodeURIComponent(sha)}`
  );

/** `base..head` commits, the three-dot diff, and whether a squash merge
 * would land cleanly. */
export const runnerGitCompare = (id: string, base: string, head: string) =>
  runnerFetch<GitCompare>(`${appPath(id)}/git/compare${query({ base, head })}`);

/** Create a branch at `from` (a ref or sha); 409 when it exists. */
export const runnerGitBranchCreate = (id: string, name: string, from: string) =>
  runnerFetch<GitBranch>(`${appPath(id)}/git/branches`, {
    body: JSON.stringify({ from, name }),
    method: "POST",
  });

/** Delete a branch; `main` is refused. */
export const runnerGitBranchDelete = (id: string, name: string) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/git/branches/${pathTail(name)}`,
    { method: "DELETE" }
  );

// Pull requests (F4). `actor` is `{userId, name}`; `role` is the caller's app
// role, computed by the UI action and trusted by the runner for policy.

export const runnerPrsList = (
  id: string,
  params: { state?: string; skip?: number; limit?: number } = {}
) =>
  runnerFetch<PrList>(
    `${appPath(id)}/pull_requests${query({
      limit: params.limit,
      skip: params.skip,
      state: params.state,
    })}`
  );

export const runnerPrGet = (id: string, number: number) =>
  runnerFetch<PrDetail>(`${appPath(id)}/pull_requests/${String(number)}`);

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
) =>
  runnerFetch<PrDetail>(`${appPath(id)}/pull_requests`, {
    body: JSON.stringify({
      actor: body.actor,
      authorLabel: body.authorLabel,
      base: body.base,
      body: body.body,
      head: body.head,
      title: body.title,
    }),
    method: "POST",
  });

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
) =>
  runnerFetch<PrDetail>(`${appPath(id)}/pull_requests/${String(number)}`, {
    body: JSON.stringify({
      actor: body.actor,
      body: body.body,
      role: body.role,
      state: body.state,
      title: body.title,
    }),
    method: "PATCH",
  });

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
) =>
  runnerFetch<PrComment>(
    `${appPath(id)}/pull_requests/${String(number)}/comments`,
    {
      body: JSON.stringify({
        actor: body.actor,
        authorLabel: body.authorLabel,
        body: body.body,
        commitSha: body.commitSha,
        line: body.line,
        path: body.path,
        role: body.role,
        side: body.side,
      }),
      method: "POST",
    }
  );

export const runnerPrCommentEdit = (
  id: string,
  commentId: string,
  body: { actor: { name: string; userId: string }; body: string }
) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/comments/${encodeURIComponent(commentId)}`,
    {
      body: JSON.stringify({ actor: body.actor, body: body.body }),
      method: "PATCH",
    }
  );

export const runnerPrCommentDelete = (
  id: string,
  commentId: string,
  body: { actor: { name: string; userId: string }; role: string }
) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/comments/${encodeURIComponent(commentId)}`,
    {
      body: JSON.stringify({ actor: body.actor, role: body.role }),
      method: "DELETE",
    }
  );

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
) =>
  runnerFetch<PrDetail>(
    `${appPath(id)}/pull_requests/${String(number)}/reviews`,
    {
      body: JSON.stringify({
        actor: body.actor,
        authorLabel: body.authorLabel,
        role: body.role,
        state: body.state,
      }),
      method: "POST",
    }
  );

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
) =>
  runnerFetch<PrDetail>(
    `${appPath(id)}/pull_requests/${String(number)}/merge`,
    {
      body: JSON.stringify({
        actor: body.actor,
        authorName: body.authorName,
        deleteBranch: body.deleteBranch,
        message: body.message,
        role: body.role,
        title: body.title,
      }),
      method: "POST",
    }
  );

export const runnerBranchRulesGet = (id: string) =>
  runnerFetch<BranchRules>(`${appPath(id)}/branch_rules`);

export const runnerBranchRulesSet = (
  id: string,
  body: { requirePr: boolean; requiredApprovals: number }
) =>
  runnerFetch<BranchRules>(`${appPath(id)}/branch_rules`, {
    body: JSON.stringify({
      requiredApprovals: body.requiredApprovals,
      requirePr: body.requirePr,
    }),
    method: "PUT",
  });

// RunnerTree/Blob are generated from host::source::{TreeResponse,
// BlobResponse}. `ref` (branch, tag or sha) selects what to browse; absent
// keeps the deployed-sha resolution.

export const runnerSourceTree = (id: string, ref?: string) =>
  runnerFetch<RunnerTree>(`${appPath(id)}/tree${query({ ref })}`);

export const runnerSourceBlob = (id: string, path: string, ref?: string) =>
  runnerFetch<RunnerBlob>(
    `${appPath(id)}/blob/${pathTail(path)}${query({ ref })}`
  );

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
  runnerFetch<RunnerEnvironment[]>(
    `${appPath(id)}/environments${query({ role })}`
  );

/** Create the branch's environment (using `label`, no override) and deploy its
 * head; `actor` names the creator. */
export const runnerEnvironmentCreate = (
  id: string,
  branch: string,
  role: string,
  actor?: SourceCommitBody["actor"]
) =>
  runnerFetch<RunnerEnvironment>(`${appPath(id)}/environments`, {
    body: JSON.stringify({ actor, branch, role }),
    method: "POST",
  });

export const runnerEnvironmentDelete = async (
  id: string,
  envId: string,
  role: string
): Promise<void> => {
  await runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}${query({ role })}`,
    { method: "DELETE" }
  );
};

export const runnerEnvironmentUpdate = (
  id: string,
  envId: string,
  isPublic: boolean,
  role: string
) =>
  runnerFetch<RunnerEnvironment>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}`,
    {
      body: JSON.stringify({ public: isPublic, role }),
      method: "PATCH",
    }
  );

/** Re-deploy one environment. `actor` is who asked, when the caller can say
 * (a profile API key's attributable label); the deploy row keeps it. */
export const runnerEnvironmentDeploy = (
  id: string,
  envId: string,
  role: string,
  actor?: string
) =>
  runnerFetch<{ deployId: string; sha: string }>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}/deploy`,
    {
      body: JSON.stringify({ actor, role }),
      method: "POST",
    }
  );

/** One environment's variable overrides (raw rows: the caller redacts). */
export const runnerEnvironmentVars = (
  id: string,
  envId: string,
  role: string
) =>
  runnerFetch<RunnerEnv[]>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}/env${query({ role })}`
  );

export const runnerEnvironmentVarSet = (
  id: string,
  envId: string,
  name: string,
  value: string,
  role: string
) =>
  runnerFetch<{ ok: boolean; name: string }>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}/env`,
    {
      body: JSON.stringify({ name, role, value }),
      method: "POST",
    }
  );

export const runnerEnvironmentVarDelete = async (
  id: string,
  envId: string,
  name: string,
  role: string
): Promise<void> => {
  await runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}/env/${encodeURIComponent(name)}${query({ role })}`,
    { method: "DELETE" }
  );
};

/** Mint the short-lived hand-back token the control UI's `/api/env-auth` route
 * redirects a browser with (the runner has no session; this is what turns
 * "this viewer may see this environment" into a token). */
export const runnerEnvironmentGrant = (
  id: string,
  envId: string,
  userId: string
) =>
  runnerFetch<EnvGrant>(
    `${appPath(id)}/environments/${encodeURIComponent(envId)}/grant`,
    {
      body: JSON.stringify({ userId }),
      method: "POST",
    }
  );

// RunnerMetric/Span/Device/Path/Ref/Event/UserProps/Insight are generated
// from the models::App*Stat rows, models::AppEvent, AppUserProps and
// AppInsight.

export const runnerGetUserProps = (
  id: string,
  userId: string,
  environmentId = ""
) =>
  runnerFetch<RunnerUserProps | null>(
    `${appPath(id)}/users/${encodeURIComponent(userId)}/props${query({
      environmentId,
    })}`
  );

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
 * computed (the runner's D1 table listing has no caps). */
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
 * top of the runner's raw schema. */
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
  runnerFetch<StorageItem[]>(`${appPath(id)}/storage`);

/** Tables + row counts of one app D1 database (counts in one batch). */
export const runnerD1Tables = (id: string, databaseId: string) =>
  runnerFetch<D1TablesRaw>(
    `${appPath(id)}/storage/d1/${encodeURIComponent(databaseId)}/tables`
  );

/** One table's schema; the action adds caps (role dependent). */
export const runnerD1Schema = (id: string, databaseId: string, table: string) =>
  runnerFetch<D1TableSchemaRaw>(
    `${appPath(id)}/storage/d1/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table)}/schema`
  );

/** One server-side page of rows (sort/filters/search applied in SQL). */
export const runnerD1Rows = (
  id: string,
  databaseId: string,
  params: D1RowsQuery
) =>
  runnerFetch<D1Rows>(
    `${appPath(id)}/storage/d1/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(params.table)}/rows`,
    {
      body: JSON.stringify({
        filters: params.filters,
        page: params.page,
        pageSize: params.pageSize,
        search: params.search,
        sort: params.sort,
      }),
      method: "POST",
    }
  );

// SourceCommitFile/Body are generated from service::source.

/** Curated tenant-DB write: single INSERT, UPDATE or DELETE (push-gated in
 * the action). */
export const runnerD1Write = (
  id: string,
  databaseId: string,
  body: D1WriteBody
) =>
  runnerFetch<{ ok: boolean }>(
    `${appPath(id)}/storage/d1/${encodeURIComponent(databaseId)}/write`,
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );

/** Delete 1..100 rows by key in one atomic batch (push-gated in the action). */
export const runnerD1DeleteRows = (
  id: string,
  databaseId: string,
  body: D1DeleteRowsBody
) =>
  runnerFetch<{ deleted: number; ok: boolean }>(
    `${appPath(id)}/storage/d1/${encodeURIComponent(databaseId)}/delete-rows`,
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );

/** Read-only Durable Object instance list for one class. */
export const runnerDoInstances = (id: string, className: string) =>
  runnerFetch<DoPreview>(
    `${appPath(id)}/storage/do/${encodeURIComponent(className)}`
  );

/** One page of an R2 bucket folder (prefix + delimiter on the store). */
export const runnerR2List = (
  id: string,
  bucket: string,
  prefix: string,
  cursor: string | null
) =>
  runnerFetch<R2Preview>(
    `${appPath(id)}/storage/r2/${encodeURIComponent(bucket)}${query({
      cursor: cursor ?? undefined,
      prefix,
    })}`
  );

/** Read-only R2 object fetch (bounded text preview, null when binary). */
export const runnerR2Get = (id: string, bucket: string, key: string) =>
  runnerFetch<R2File>(
    `${appPath(id)}/storage/r2/${encodeURIComponent(bucket)}/object${query({ key })}`
  );

/** Delete 1..100 R2 objects in one call (push-gated in the action). */
export const runnerR2Delete = (id: string, bucket: string, keys: string[]) =>
  runnerFetch<{ deleted: number }>(
    `${appPath(id)}/storage/r2/${encodeURIComponent(bucket)}/delete`,
    {
      body: JSON.stringify({ keys }),
      method: "POST",
    }
  );

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
