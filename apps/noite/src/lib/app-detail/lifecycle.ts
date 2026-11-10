//! One reading of every runner lifecycle string an app page paints: the app
//! row, a deploy row and an environment row. The wire values are the runner's
//! own (`lowercase` column strings); this module turns them into closed types
//! and one facts table per machine, so no component compares status strings
//! inline and a new runner variant fails to compile here first.
//!
//! `AppStatus` and `DeployStatus` are the runner's own ts-rs bindings
//! (`lib/runner-types`), so a variant the runner adds lands here first: the
//! `satisfies Record<…>` tables below pin every status, and a missing entry
//! fails the compile. `AppStatusPage.status` stays a plain string because
//! callers also paint rows whose status the wire did not type; the runtime
//! decode (`isAppStatus`) turns those into the generated union.
//!
//! App lifecycle (`appLifecycle`) — status × desiredState × imported:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> NeverDeployed: status provisioned
//!   [*] --> Importing: status importing
//!   [*] --> ImportFailed: status error
//!   [*] --> Deploying: status building | deploying
//!   [*] --> Live: status running
//!   [*] --> Live: status sleeping (asleep)
//!   [*] --> Stopping: desired stopped, not yet stopped
//!   [*] --> Stopped: desired stopped, status stopped
//!   [*] --> Starting: desired running, status stopped
//!   [*] --> Failed: status failed
//!   [*] --> Unknown: any other string
//! ```
//!
//! Every transition is a pure re-derivation: the runner is the only writer,
//! the UI paints one function of its row. `canStart`/`canStop` and `action`
//! come from `desiredState`, and `label`/`tone` are derived together, so the
//! dot and the Start/Stop label can never disagree.

import { Data } from "effect";

import type { AppStatus } from "../runner-types/AppStatus";
import type { DeployStatus } from "../runner-types/DeployStatus";
import type { DesiredState } from "../runner-types/DesiredState";

export type { DesiredState } from "../runner-types/DesiredState";

export interface AppStatusPage {
  readonly desiredState?: string | undefined;
  readonly imported?: boolean | undefined;
  readonly status: string;
}

/** An environment's observed status uses the app vocabulary. */
export type EnvironmentStatus = AppStatus;

export const parseDesiredState = (raw: string): DesiredState | null => {
  if (raw === "running" || raw === "stopped") {
    return raw;
  }

  return null;
};

/** Status tone a daisyUI `status` dot takes. */
export type StatusTone =
  | "status-success"
  | "status-warning"
  | "status-error"
  | "status-neutral";

export interface AppStatusFacts {
  readonly label: string;
  readonly tone: StatusTone;
  /** The runner is mid-pipeline: a Start/Stop is pointless, a deploy row is
   * in flight. */
  readonly inFlight: boolean;
  /** A stop or start is worth offering (something has been deployed). */
  readonly deployed: boolean;
  /** A retry of the import is accepted (failed, or an import with a stored
   * source that a restart interrupted). */
  readonly retryable: boolean;
}

const APP_FACTS = {
  building: {
    deployed: true,
    inFlight: true,
    label: "Building",
    retryable: false,
    tone: "status-warning",
  },
  deploying: {
    deployed: true,
    inFlight: true,
    label: "Deploying",
    retryable: false,
    tone: "status-warning",
  },
  error: {
    deployed: false,
    inFlight: false,
    label: "Error",
    retryable: true,
    tone: "status-error",
  },
  failed: {
    deployed: true,
    inFlight: false,
    label: "Failed",
    retryable: false,
    tone: "status-error",
  },
  importing: {
    deployed: false,
    inFlight: true,
    label: "Importing",
    retryable: true,
    tone: "status-warning",
  },
  pending: {
    deployed: false,
    inFlight: false,
    label: "pending",
    retryable: false,
    tone: "status-warning",
  },
  provisioned: {
    deployed: false,
    inFlight: false,
    label: "Provisioned",
    retryable: false,
    tone: "status-warning",
  },
  running: {
    deployed: true,
    inFlight: false,
    label: "Running",
    retryable: false,
    tone: "status-success",
  },
  sleeping: {
    deployed: true,
    inFlight: false,
    label: "Sleeping",
    retryable: false,
    tone: "status-neutral",
  },
  stopped: {
    deployed: true,
    inFlight: false,
    label: "Stopped",
    retryable: false,
    tone: "status-neutral",
  },
} as const satisfies Record<AppStatus, AppStatusFacts>;

const UNKNOWN_APP: AppStatusFacts = {
  deployed: true,
  inFlight: false,
  label: "Unknown",
  retryable: false,
  tone: "status-warning",
};

export const isAppStatus = (raw: string): raw is AppStatus =>
  Object.hasOwn(APP_FACTS, raw);

/** Facts for one status string; an unmodelled string reads as warning and
 * `Unknown`, never silently as another state. */
export const appStatusFacts = (raw: string): AppStatusFacts =>
  isAppStatus(raw) ? APP_FACTS[raw] : { ...UNKNOWN_APP, label: raw };

export interface DeployStatusFacts {
  readonly label: string;
  /** A row the runner can still stop: it is holding (or waiting for) the
   * app's deploy claim. */
  readonly inFlight: boolean;
  /** A finished row: its log is immutable. */
  readonly finished: boolean;
  readonly succeeded: boolean;
}

const DEPLOY_FACTS = {
  building: {
    finished: false,
    inFlight: true,
    label: "building",
    succeeded: false,
  },
  deploying: {
    finished: false,
    inFlight: true,
    label: "deploying",
    succeeded: false,
  },
  failed: {
    finished: true,
    inFlight: false,
    label: "failed",
    succeeded: false,
  },
  queued: {
    finished: false,
    inFlight: true,
    label: "queued",
    succeeded: false,
  },
  success: {
    finished: true,
    inFlight: false,
    label: "success",
    succeeded: true,
  },
} as const satisfies Record<DeployStatus, DeployStatusFacts>;

export const isDeployStatus = (raw: string): raw is DeployStatus =>
  Object.hasOwn(DEPLOY_FACTS, raw);

const UNKNOWN_DEPLOY: DeployStatusFacts = {
  finished: true,
  inFlight: false,
  label: "unknown",
  succeeded: false,
};

export const deployStatusFacts = (raw: string): DeployStatusFacts =>
  isDeployStatus(raw) ? DEPLOY_FACTS[raw] : UNKNOWN_DEPLOY;

/** Production deploy rows carry `null` (the runner stores NULL); older
 * frames and fixtures may say `""`. Either is production. */
export const isProductionRow = (environmentId: string | null): boolean =>
  environmentId === null || environmentId === "";

/** Whether an app or environment is serving traffic at all. A deliberate
 * stop (desired or observed) means its history has no live release; a build
 * in flight or a failed deploy keeps the previous release up. */
export const isServing = (row: {
  readonly desiredState: string;
  readonly status: string;
}): boolean =>
  parseDesiredState(row.desiredState) !== "stopped" && row.status !== "stopped";

/** Badge style for one deploy status row. */
export const deployBadgeTone = (raw: string): string => {
  const facts = deployStatusFacts(raw);

  if (facts.succeeded) {
    return "badge-primary";
  }

  if (facts.finished) {
    return "badge-error";
  }

  return "badge-warning";
};

/** What the environment header must surface beyond the status dot: a
 * deliberate stop (`desired_state = 'stopped'`) outranks a stale observed
 * status, and a stopped environment is not serving traffic. */
export interface EnvironmentHeaderState {
  readonly desiredState: DesiredState;
  readonly label: string;
  readonly tone: StatusTone;
  readonly stopped: boolean;
  /** `lastError` to show even while stopped (a stop does not erase why the
   * last deploy failed). */
  readonly error: string | null;
}

export const environmentHeaderState = (env: {
  readonly desiredState: string;
  readonly lastError: string | null;
  readonly status: string;
}): EnvironmentHeaderState => {
  const desiredState = parseDesiredState(env.desiredState) ?? "running";

  if (desiredState === "stopped") {
    return {
      desiredState,
      error: env.lastError,
      label: env.status === "stopped" ? "Stopped" : "Stopping",
      stopped: true,
      tone: env.status === "stopped" ? "status-neutral" : "status-warning",
    };
  }

  const facts = appStatusFacts(env.status);

  return {
    desiredState,
    error: env.lastError,
    label: facts.label,
    stopped: false,
    tone: facts.tone,
  };
};

/** The one app-header lifecycle: one closed union derived from the runner's
 * row, so the dot, the label and the Start/Stop action agree. */
export type AppLifecycle = Data.TaggedEnum<{
  NeverDeployed: Record<never, never>;
  Importing: { readonly retryable: boolean };
  ImportFailed: { readonly retryable: boolean };
  Deploying: Record<never, never>;
  Live: { readonly asleep: boolean };
  Starting: Record<never, never>;
  Stopping: Record<never, never>;
  Stopped: Record<never, never>;
  Failed: Record<never, never>;
  Unknown: { readonly status: string };
}>;

export const AppLifecycleTypes = Data.taggedEnum<AppLifecycle>();

export const appLifecycle = (app: AppStatusPage): AppLifecycle => {
  const desiredState = parseDesiredState(app.desiredState ?? "") ?? "running";

  if (app.status === "provisioned") {
    return AppLifecycleTypes.NeverDeployed();
  }

  if (app.status === "importing") {
    return AppLifecycleTypes.Importing({ retryable: app.imported === true });
  }

  if (app.status === "error") {
    return AppLifecycleTypes.ImportFailed({ retryable: app.imported === true });
  }

  if (app.status === "building" || app.status === "deploying") {
    return AppLifecycleTypes.Deploying();
  }

  if (desiredState === "stopped") {
    return app.status === "stopped"
      ? AppLifecycleTypes.Stopped()
      : AppLifecycleTypes.Stopping();
  }

  if (app.status === "running") {
    return AppLifecycleTypes.Live({ asleep: false });
  }

  if (app.status === "sleeping") {
    return AppLifecycleTypes.Live({ asleep: true });
  }

  if (app.status === "stopped") {
    return AppLifecycleTypes.Starting();
  }

  if (app.status === "failed") {
    return AppLifecycleTypes.Failed();
  }

  return AppLifecycleTypes.Unknown({ status: app.status });
};

export interface LifecycleView {
  /** The status dot's tone. */
  readonly tone: StatusTone;
  /** The text next to the dot. */
  readonly label: string;
  /** The header's one toggle, or null when the app has nothing to run yet. */
  readonly action: "start" | "stop" | null;
  readonly retryable: boolean;
}

/** Derive the header's paint from {@link appLifecycle}: the toggle follows
 * `desiredState`, the label follows the observed row — but both come from
 * the same union, so "Stop" never sits beside a "Stopped" dot. */
export const lifecycleView = (
  lifecycle: AppLifecycle,
  desiredState: string
): LifecycleView => {
  const action =
    parseDesiredState(desiredState) === "stopped" ? "start" : "stop";

  switch (lifecycle._tag) {
    case "NeverDeployed": {
      return {
        action: null,
        label: "Provisioned",
        retryable: false,
        tone: "status-warning",
      };
    }

    case "Importing": {
      return {
        action: null,
        label: "Importing",
        retryable: lifecycle.retryable,
        tone: "status-warning",
      };
    }

    case "ImportFailed": {
      return {
        action: null,
        label: "Error",
        retryable: lifecycle.retryable,
        tone: "status-error",
      };
    }

    case "Deploying": {
      return {
        action,
        label: "Deploying",
        retryable: false,
        tone: "status-warning",
      };
    }

    case "Live": {
      return {
        action,
        label: lifecycle.asleep ? "Sleeping" : "Running",
        retryable: false,
        tone: lifecycle.asleep ? "status-neutral" : "status-success",
      };
    }

    case "Starting": {
      return {
        action,
        label: "Starting",
        retryable: false,
        tone: "status-warning",
      };
    }

    case "Stopping": {
      return {
        action,
        label: "Stopping",
        retryable: false,
        tone: "status-warning",
      };
    }

    case "Stopped": {
      return {
        action,
        label: "Stopped",
        retryable: false,
        tone: "status-neutral",
      };
    }

    case "Failed": {
      return {
        action,
        label: "Failed",
        retryable: false,
        tone: "status-error",
      };
    }

    case "Unknown": {
      return {
        action,
        label: lifecycle.status,
        retryable: false,
        tone: "status-warning",
      };
    }

    default: {
      return {
        action,
        label: "Unknown",
        retryable: false,
        tone: "status-warning",
      };
    }
  }
};

/** The error-issue lifecycle the runner documents (`db/errors.rs`): an
 * ignored issue never reopens; a resolved one does, and then carries
 * `regressed = 1`. */
export type IssueState = Data.TaggedEnum<{
  Open: { readonly regressed: boolean };
  Resolved: { readonly regressed: boolean };
  Ignored: Record<never, never>;
}>;

export const IssueStateTypes = Data.taggedEnum<IssueState>();

export const issueState = (issue: {
  readonly regressed: boolean;
  readonly status: string;
}): IssueState => {
  if (issue.status === "resolved") {
    return IssueStateTypes.Resolved({ regressed: issue.regressed });
  }

  if (issue.status === "ignored") {
    return IssueStateTypes.Ignored();
  }

  return IssueStateTypes.Open({ regressed: issue.regressed });
};

/** The triage buttons one issue offers, as the status it would write. */
export const issueActions = (
  state: IssueState
): readonly ("ignored" | "open" | "resolved")[] =>
  state._tag === "Open" ? ["ignored", "resolved"] : ["open"];

export const issueNote = (state: IssueState): string => {
  switch (state._tag) {
    case "Resolved": {
      return "Resolved — reopens if it happens again.";
    }

    case "Ignored": {
      return "Ignored — still counted, never reopened.";
    }

    default: {
      return "";
    }
  }
};

/** A custom domain's claim: `pending` until the TXT token is verified. */
export type DomainClaim = Data.TaggedEnum<{
  Pending: { readonly token: string };
  Verified: Record<never, never>;
}>;

export const DomainClaimTypes = Data.taggedEnum<DomainClaim>();

export const domainClaim = (row: {
  readonly status: string;
  readonly token: string;
}): DomainClaim =>
  row.status === "verified"
    ? DomainClaimTypes.Verified()
    : DomainClaimTypes.Pending({ token: row.token });
