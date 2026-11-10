//! The deploy row's action group and the header's Deploy dropdown as two
//! explicit machines. Both are `@ilha/model` apps; this module holds their
//! models, messages, the one `update` each, and the commands those updates
//! return. The components in `deploys.tsx` only dispatch and paint.
//!
//! Deploy row (`RowAction`) — one row's destructive actions:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Stopping: StopRequested
//!   Idle --> RollingBack: RollbackRequested
//!   Stopping --> Idle: StopSucceeded
//!   Stopping --> AlreadyClosed: StopRequested refused (409)
//!   Stopping --> Failed: StopFailed
//!   RollingBack --> Idle: RollbackSucceeded
//!   RollingBack --> Failed: RollbackFailed
//!   AlreadyClosed --> Idle: NoticeDismissed
//!   Failed --> Idle: NoticeDismissed
//! ```
//!
//! Any request while a call is in flight is refused (the model is returned
//! unchanged), so a double click can never issue two cancels or rollbacks.
//! A 409 reads as `AlreadyClosed` — an information, not the red error a
//! failed call paints: the runner already closed the row.
//!
//! Deploy dropdown:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Loading: TargetsOpened
//!   Loading --> Found: TargetsLoaded(sha)
//!   Loading --> None: TargetsLoaded(null)
//!   Loading --> LookupFailed: TargetsFailed
//!   Found --> Redeploying: RedeployRequested
//!   Found --> RollingBack: RollbackRequested
//!   Redeploying --> Loading: Succeeded (reload targets)
//!   RollingBack --> Loading: Succeeded (reload targets)
//!   Redeploying --> ActionFailed: Failed
//!   RollingBack --> ActionFailed: Failed
//!   LookupFailed --> Loading: TargetsOpened
//!   ActionFailed --> Loading: TargetsOpened
//!   None --> Loading: TargetsOpened
//! ```
//!
//! A failed lookup is its own state (`LookupFailed`), rendered as a failure
//! with a retry — never as "no earlier deploy to roll back to".

/* oxlint-disable promise/prefer-await-to-callbacks -- a command factory takes message constructors, not continuation callbacks: the Effect runs them and every answer becomes a message */
import { keyed } from "@ilha/model";
import type { Cmd } from "@ilha/model";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { api, ApiError } from "../api";
import { errorMessage } from "../errors";
import { isProductionRow } from "./lifecycle";
import type { Step } from "./step";

/** A 409 from the runner: the deploy row is already closed. */
const isConflict = (error: Error): boolean =>
  error instanceof ApiError && error.status === 409;

const attempt = <Message>(
  work: () => Promise<void>,
  ok: () => Message,
  fail: (error: Error) => Message
): Cmd<Message> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: work,
  }).pipe(
    Effect.match({ onFailure: (error) => fail(error), onSuccess: () => ok() })
  );

// --- deploy row -----------------------------------------------------------

export type RowAction = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Stopping: Record<never, never>;
  RollingBack: Record<never, never>;
  AlreadyClosed: Record<never, never>;
  Failed: { readonly kind: "rollback" | "stop"; readonly error: string };
}>;

export const RowActionTypes = Data.taggedEnum<RowAction>();

export interface RowModel {
  /** `null` until the reader toggles: then the row follows `live`. */
  readonly expanded: boolean | null;
  readonly action: RowAction;
  readonly tab: "build" | "deploy";
}

export type RowMessage = Data.TaggedEnum<{
  LogsToggled: { readonly live: boolean };
  NoticeDismissed: Record<never, never>;
  RollbackFailed: { readonly error: string };
  RollbackRequested: {
    readonly appId: string;
    readonly deployId: string;
    readonly environmentId: string;
    readonly sha: string;
  };
  RollbackSucceeded: Record<never, never>;
  StopConflict: Record<never, never>;
  StopFailed: { readonly error: string };
  StopRequested: {
    readonly appId: string;
    readonly deployId: string;
  };
  StopSucceeded: Record<never, never>;
  TabPicked: { readonly tab: "build" | "deploy" };
}>;

export const RowMsg = Data.taggedEnum<RowMessage>();

const stopDeploy = (appId: string, deployId: string): Cmd<RowMessage> =>
  attempt<RowMessage>(
    async () => {
      await api<{ ok: true }>("/api/apps/cancelDeploy", { appId, deployId });
    },
    () => RowMsg.StopSucceeded(),
    (error) =>
      isConflict(error)
        ? RowMsg.StopConflict()
        : RowMsg.StopFailed({ error: error.message })
  );

const rollbackDeploy = (
  appId: string,
  environmentId: string,
  sha: string
): Cmd<RowMessage> =>
  attempt<RowMessage>(
    async () => {
      await api<{ ok: true }>("/api/apps/rollback", {
        appId,
        environmentId,
        sha,
      });
    },
    () => RowMsg.RollbackSucceeded(),
    (error) => RowMsg.RollbackFailed({ error: error.message })
  );

/** Whether the row's log pane opens without a click. */
export const rowOpen = (model: RowModel, live: boolean): boolean =>
  model.expanded ?? live;

/** The one transition function for a deploy row. */
export const updateRow = (
  model: RowModel,
  message: RowMessage
): Step<RowModel, RowMessage> => {
  switch (message._tag) {
    case "LogsToggled": {
      return {
        model: { ...model, expanded: !rowOpen(model, message.live) },
      };
    }

    case "TabPicked": {
      return { model: { ...model, tab: message.tab } };
    }

    case "NoticeDismissed": {
      return { model: { ...model, action: RowActionTypes.Idle() } };
    }

    case "StopRequested": {
      // One destructive call at a time: a second click (or a Stop on a row
      // the runner already closed) changes nothing.
      if (model.action._tag !== "Idle") {
        return { model };
      }

      return {
        cmd: keyed(
          `stop:${message.deployId}`,
          stopDeploy(message.appId, message.deployId)
        ),
        model: { ...model, action: RowActionTypes.Stopping() },
      };
    }

    case "RollbackRequested": {
      if (model.action._tag !== "Idle" || !message.sha) {
        return { model };
      }

      return {
        cmd: keyed(
          `rollback:${message.deployId}`,
          rollbackDeploy(message.appId, message.environmentId, message.sha)
        ),
        model: { ...model, action: RowActionTypes.RollingBack() },
      };
    }

    case "StopSucceeded":
    case "RollbackSucceeded": {
      return { model: { ...model, action: RowActionTypes.Idle() } };
    }

    case "StopConflict": {
      return {
        model: { ...model, action: RowActionTypes.AlreadyClosed() },
      };
    }

    case "StopFailed": {
      return {
        model: {
          ...model,
          action: RowActionTypes.Failed({
            error: message.error,
            kind: "stop",
          }),
        },
      };
    }

    case "RollbackFailed": {
      return {
        model: {
          ...model,
          action: RowActionTypes.Failed({
            error: message.error,
            kind: "rollback",
          }),
        },
      };
    }

    default: {
      return { model };
    }
  }
};

// --- deploy dropdown ------------------------------------------------------

export type Lookup = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Loading: Record<never, never>;
  Found: { readonly candidates: readonly string[] };
  None: Record<never, never>;
  Failed: { readonly error: string };
}>;

export const LookupTypes = Data.taggedEnum<Lookup>();

export type DropdownAction = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Redeploying: Record<never, never>;
  RollingBack: Record<never, never>;
  Failed: {
    readonly kind: "redeploy" | "rollback";
    readonly error: string;
  };
}>;

export const DropdownActionTypes = Data.taggedEnum<DropdownAction>();

export interface DropdownModel {
  readonly appId: string;
  readonly action: DropdownAction;
  /** The release serving right now: a target equal to it is not a rollback. */
  readonly liveSha: string | null;
  readonly lookup: Lookup;
}

export type DropdownMessage = Data.TaggedEnum<{
  RollbackFailed: { readonly error: string };
  RollbackRequested: { readonly sha: string };
  RedeployFailed: { readonly error: string };
  RedeployRequested: { readonly sha: string };
  Succeeded: Record<never, never>;
  TargetsFailed: { readonly error: string };
  TargetsLoaded: { readonly candidates: readonly string[] };
  TargetsOpened: { readonly liveSha: string | null };
}>;

export const DropdownMsg = Data.taggedEnum<DropdownMessage>();

const loadTargets = (appId: string): Cmd<DropdownMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: () =>
      api<
        readonly {
          environmentId: string | null;
          sha: string | null;
          status: string;
        }[]
      >("/api/apps/listDeploys", { appId }),
  }).pipe(
    Effect.match({
      onFailure: (error) => DropdownMsg.TargetsFailed({ error: error.message }),
      onSuccess: (rows) =>
        // Every successful production release, newest first. The live sha is
        // picked against at render, not here: a lookup opened while the app
        // detail is still the previous snapshot (`lastDeploySha` null or
        // stale) must not freeze a target the current live release makes
        // wrong — the header's own detail lands a beat after a page load.
        DropdownMsg.TargetsLoaded({
          candidates: rows
            .filter(
              (row) =>
                isProductionRow(row.environmentId) &&
                row.status === "success" &&
                !!row.sha
            )
            .map((row) => row.sha ?? ""),
        }),
    })
  );

/** Both header actions re-run the pipeline at a sha; only the failure a
 * user reads back differs. */
const rollbackCall = (
  appId: string,
  sha: string,
  failed: (error: string) => DropdownMessage
): Cmd<DropdownMessage> =>
  attempt<DropdownMessage>(
    async () => {
      await api<{ ok: true }>("/api/apps/rollback", { appId, sha });
    },
    () => DropdownMsg.Succeeded(),
    (error) =>
      isConflict(error) ? DropdownMsg.Succeeded() : failed(errorMessage(error))
  );

/** The rollback target the loaded history offers against `liveSha`: the
 * newest successful production release that is not serving now. A target
 * equal to the live sha would only rebuild what runs. */
export const rollbackTarget = (
  candidates: readonly string[],
  liveSha: string | null
): string => candidates.find((sha) => sha !== "" && sha !== liveSha) ?? "";

/** The one transition function for the Deploy dropdown. */
export const updateDropdown = (
  model: DropdownModel,
  message: DropdownMessage
): Step<DropdownModel, DropdownMessage> => {
  switch (message._tag) {
    case "TargetsOpened": {
      return {
        cmd: keyed(`targets:${model.appId}`, loadTargets(model.appId)),
        model: {
          ...model,
          liveSha: message.liveSha,
          lookup: LookupTypes.Loading(),
        },
      };
    }

    case "TargetsLoaded": {
      // Only an open dropdown accepts a lookup answer; a late answer after a
      // second open must not overwrite the newer one (the keyed command
      // already interrupts, this keeps the state honest).
      if (model.lookup._tag !== "Loading") {
        return { model };
      }

      return {
        model: {
          ...model,
          lookup:
            message.candidates.length === 0
              ? LookupTypes.None()
              : LookupTypes.Found({ candidates: message.candidates }),
        },
      };
    }

    case "TargetsFailed": {
      if (model.lookup._tag !== "Loading") {
        return { model };
      }

      return {
        model: {
          ...model,
          lookup: LookupTypes.Failed({ error: message.error }),
        },
      };
    }

    case "RedeployRequested": {
      if (model.action._tag !== "Idle" || !message.sha) {
        return { model };
      }

      return {
        cmd: keyed(
          `redeploy:${model.appId}`,
          rollbackCall(model.appId, message.sha, (error) =>
            DropdownMsg.RedeployFailed({ error })
          )
        ),
        model: {
          ...model,
          action: DropdownActionTypes.Redeploying(),
        },
      };
    }

    case "RollbackRequested": {
      // The target must still be one this machine loaded: a sha the view
      // computed after a refetch is not a target it accepted.
      if (
        model.action._tag !== "Idle" ||
        model.lookup._tag !== "Found" ||
        !model.lookup.candidates.includes(message.sha)
      ) {
        return { model };
      }

      return {
        cmd: keyed(
          `rollback-target:${model.appId}`,
          rollbackCall(model.appId, message.sha, (error) =>
            DropdownMsg.RollbackFailed({ error })
          )
        ),
        model: {
          ...model,
          action: DropdownActionTypes.RollingBack(),
        },
      };
    }

    case "Succeeded": {
      // A rollback moves `lastDeploySha`: reload the target before offering
      // another action, so the dropdown never offers the release now live.
      return {
        cmd: keyed(`targets:${model.appId}`, loadTargets(model.appId)),
        model: {
          ...model,
          action: DropdownActionTypes.Idle(),
          lookup: LookupTypes.Loading(),
        },
      };
    }

    case "RedeployFailed": {
      return {
        model: {
          ...model,
          action: DropdownActionTypes.Failed({
            error: message.error,
            kind: "redeploy",
          }),
        },
      };
    }

    case "RollbackFailed": {
      return {
        model: {
          ...model,
          action: DropdownActionTypes.Failed({
            error: message.error,
            kind: "rollback",
          }),
        },
      };
    }

    default: {
      return { model };
    }
  }
};
