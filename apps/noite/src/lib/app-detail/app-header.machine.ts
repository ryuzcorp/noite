//! The app header's one pending-action machine. The runner's app state stream
//! (`/api/apps/:id/state/stream`) is the authority: a Start, a Stop or an
//! import retry is pending until a frame says the row converged, and a
//! deadline turns silence into an explicit `TimedOut` notice instead of a
//! button that quietly re-enables.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Starting: ToggleRequested(running)
//!   Idle --> Stopping: ToggleRequested(stopped)
//!   Idle --> Retrying: RetryRequested
//!   Starting --> Idle: FrameReceived (desired running, running/sleeping)
//!   Starting --> Idle: FrameReceived (desired stopped — someone else won)
//!   Stopping --> Idle: FrameReceived (desired stopped, status stopped)
//!   Retrying --> Idle: FrameReceived (status != importing)
//!   Starting --> TimedOut: Settled(seq)
//!   Stopping --> TimedOut: Settled(seq)
//!   Retrying --> TimedOut: Settled(seq)
//!   Starting --> Failed: SaveFailed
//!   Stopping --> Failed: SaveFailed
//!   Retrying --> Failed: RetryFailed
//!   TimedOut --> Idle: ToggleRequested | RetryRequested
//!   Failed --> Idle: ToggleRequested | RetryRequested
//! ```
//!
//! Every async answer carries the `seq` of the request it belongs to, so a
//! superseded deadline or failure cannot clear a newer action. A second
//! toggle while one is pending is refused, never sent.

/* oxlint-disable promise/prefer-await-to-callbacks -- the timeout and API work are message constructors handed to a command, not continuation callbacks */
import { keyed } from "@ilha/model";
import type { Cmd } from "@ilha/model";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { api } from "../api";
import { errorMessage } from "../errors";
import type { AppStatus } from "../runner-types/AppStatus";
import type { DesiredState } from "../runner-types/DesiredState";
import { appLifecycle, appStatusFacts } from "./lifecycle";
import type { Step } from "./step";

/** How long a Start/Stop may take to show up on the state stream before the
 * header says so. The runner's reconcile loop runs every few seconds. */
export const CONVERGE_TIMEOUT_MS = 60_000;

/** An import clones a repo and builds it: minutes, not seconds. */
export const IMPORT_TIMEOUT_MS = 180_000;

export type Pending = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Starting: { readonly seq: number };
  Stopping: { readonly seq: number };
  Retrying: { readonly seq: number };
}>;

export const PendingTypes = Data.taggedEnum<Pending>();

export type HeaderNotice = Data.TaggedEnum<{
  None: Record<never, never>;
  Failure: { readonly message: string };
  TimedOut: { readonly action: "retry" | "start" | "stop" };
}>;

export const HeaderNoticeTypes = Data.taggedEnum<HeaderNotice>();

export interface HeaderModel {
  readonly appId: string;
  readonly notice: HeaderNotice;
  readonly pending: Pending;
  readonly seq: number;
}

export type HeaderMessage = Data.TaggedEnum<{
  FrameReceived: {
    readonly desiredState: DesiredState;
    readonly status: AppStatus;
  };
  NoticeDismissed: Record<never, never>;
  RetryFailed: { readonly error: string };
  RetryRequested: Record<never, never>;
  SaveFailed: { readonly error: string; readonly seq: number };
  Saved: { readonly seq: number };
  Settled: {
    readonly action: "retry" | "start" | "stop";
    readonly seq: number;
  };
  ToggleRequested: { readonly next: "running" | "stopped" };
}>;

export const HeaderMsg = Data.taggedEnum<HeaderMessage>();

/** The one failure notice construction, so the `update` branches stay plain. */
const failureNotice = (message: string): HeaderNotice =>
  HeaderNoticeTypes.Failure({ message });

const saveDesired = (
  appId: string,
  next: "running" | "stopped",
  seq: number
): Cmd<HeaderMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: () =>
      api<{ ok: true }>("/api/apps/setDesired", {
        desiredState: next,
        id: appId,
      }),
  }).pipe(
    Effect.match({
      onFailure: (error) => HeaderMsg.SaveFailed({ error: error.message, seq }),
      onSuccess: () => HeaderMsg.Saved({ seq }),
    })
  );

const retryImport = (appId: string, seq: number): Cmd<HeaderMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: () => api<{ ok: true }>("/api/apps/retryImport", appId),
  }).pipe(
    Effect.match({
      onFailure: (error) => HeaderMsg.RetryFailed({ error: error.message }),
      onSuccess: () => HeaderMsg.Saved({ seq }),
    })
  );

const settle = (
  action: "retry" | "start" | "stop",
  seq: number,
  timeoutMs: number
): Cmd<HeaderMessage> =>
  Effect.sleep(timeoutMs).pipe(
    Effect.map(() => HeaderMsg.Settled({ action, seq }))
  );

const pendingKind = (pending: Pending): "retry" | "start" | "stop" | null => {
  switch (pending._tag) {
    case "Starting": {
      return "start";
    }

    case "Stopping": {
      return "stop";
    }

    case "Retrying": {
      return "retry";
    }

    default: {
      return null;
    }
  }
};

/** Whether a state frame proves the current pending action finished. A
 * `Starting` app is converged once its row can serve (or someone else set
 * `desiredState=stopped`); a `Stopping` app once the lifecycle observes the
 * stop; a retry once the import is no longer the row's state. */
export const converged = (
  pending: Pending,
  status: AppStatus,
  desiredState: DesiredState
): boolean => {
  const lifecycle = appLifecycle({ desiredState, status });

  switch (pending._tag) {
    case "Starting": {
      return desiredState === "stopped" || appStatusFacts(status).live;
    }

    case "Stopping": {
      return lifecycle._tag === "Stopped";
    }

    case "Retrying": {
      return lifecycle._tag !== "Importing";
    }

    default: {
      return false;
    }
  }
};

/** The one transition function for the app header. */
export const updateHeader = (
  model: HeaderModel,
  message: HeaderMessage
): Step<HeaderModel, HeaderMessage> => {
  switch (message._tag) {
    case "ToggleRequested": {
      if (model.pending._tag !== "Idle") {
        return { model };
      }

      const seq = model.seq + 1;
      const kind = message.next === "running" ? "start" : "stop";

      return {
        cmd: [
          keyed(
            `desired:${model.appId}`,
            saveDesired(model.appId, message.next, seq)
          ),
          settle(kind, seq, CONVERGE_TIMEOUT_MS),
        ],
        model: {
          ...model,
          notice: HeaderNoticeTypes.None(),
          pending:
            kind === "start"
              ? PendingTypes.Starting({ seq })
              : PendingTypes.Stopping({ seq }),
          seq,
        },
      };
    }

    case "RetryRequested": {
      if (model.pending._tag !== "Idle") {
        return { model };
      }

      const seq = model.seq + 1;

      return {
        cmd: [
          keyed(`retry:${model.appId}`, retryImport(model.appId, seq)),
          settle("retry", seq, IMPORT_TIMEOUT_MS),
        ],
        model: {
          ...model,
          notice: HeaderNoticeTypes.None(),
          pending: PendingTypes.Retrying({ seq }),
          seq,
        },
      };
    }

    case "FrameReceived": {
      if (!converged(model.pending, message.status, message.desiredState)) {
        return { model };
      }

      return { model: { ...model, pending: PendingTypes.Idle() } };
    }

    case "Saved": {
      // The call landed; the frame is what ends the wait. Ignore a stale ack.
      return { model };
    }

    case "SaveFailed": {
      if (model.pending._tag === "Idle" || model.seq !== message.seq) {
        return { model };
      }

      return {
        model: {
          ...model,
          notice: failureNotice(message.error),
          pending: PendingTypes.Idle(),
        },
      };
    }

    case "RetryFailed": {
      if (model.pending._tag !== "Retrying") {
        return { model };
      }

      return {
        model: {
          ...model,
          notice: failureNotice(message.error),
          pending: PendingTypes.Idle(),
        },
      };
    }

    case "Settled": {
      // A deadline only fires for the action it was started for: a newer one
      // has a newer `seq` and is left alone.
      if (
        model.seq !== message.seq ||
        pendingKind(model.pending) !== message.action
      ) {
        return { model };
      }

      return {
        model: {
          ...model,
          notice: HeaderNoticeTypes.TimedOut({ action: message.action }),
          pending: PendingTypes.Idle(),
        },
      };
    }

    case "NoticeDismissed": {
      return { model: { ...model, notice: HeaderNoticeTypes.None() } };
    }

    default: {
      return { model };
    }
  }
};
