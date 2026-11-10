//! The `/account` admin settings machine, shared by the release-check card and
//! the telemetry card. They were two copies of the same code and had already
//! drifted once (update has a background `checking`, telemetry does not).
//!
//! States:
//!
//! | state    | shows                                              | next |
//! | -------- | -------------------------------------------------- | ---- |
//! | `Loading` | skeleton                                          | `Loaded`, `LoadFailed` |
//! | `Failed`  | load error + retry                                 | `Loaded` |
//! | `Locked`  | the operator's switch, and the *stored* preference | `Loaded` |
//! | `Ready`   | checkbox = `draft`, Save, `save`/`check` sub-state  | `Toggled`, `SaveStarted`, ... |
//!
//! Fixed here, at the one constructor and the one transition:
//! - while locked, the card still shows the *stored* preference (the old
//!   `enabled = locked ? false : …` hid it, so an operator could not tell
//!   "stored on, ignored" from "stored off");
//! - "saved" survives a refetch only while the stored value is unchanged, so a
//!   change from another tab cannot leave a stale confirmation on screen;
//! - `check: "running"` ends when a load reports a newer `checkedAt`/`latest`
//!   (the runner has no persisted `checking` field, so this is the honest
//!   bound: the card never invents one).
import { Data } from "effect";

import { errorMessage } from "../errors";

/** What both cards read from the server; the runner's own shapes extend it. */
export interface SettingStatus {
  readonly enabled: boolean;
  readonly checkedAt?: string | null;
  readonly latest?: string | null;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly setting: boolean;
}

export type SavePhase = "error" | "idle" | "saved" | "saving";

export type CheckPhase = "idle" | "running";

export type SettingsState = Data.TaggedEnum<{
  Failed: { readonly message: string };
  Loading: Record<never, never>;
  Locked: { readonly reason: string | null; readonly stored: boolean };
  Ready: {
    /** The mark the last save saw, so a later load can retire "saved". */
    readonly baseline: boolean;
    /** The server answer this model was folded from. `syncStatus` compares it
     * with the render's answer, so a re-render cannot replay `Loaded` over a
     * user's edit (that made the checkbox flip back on every click). */
    readonly seen: string;
    readonly check: CheckPhase;
    /** The newest release seen when the check started (`latest`), or "". */
    readonly checkMark: string;
    readonly draft: boolean;
    readonly error: string | null;
    readonly save: SavePhase;
    readonly stored: boolean;
  };
}>;

export const Settings = Data.taggedEnum<SettingsState>();

export type SettingsEvent = Data.TaggedEnum<{
  LoadFailed: { readonly message: string };
  Loaded: { readonly status: SettingStatus };
  SaveFailed: { readonly message: string };
  SaveStarted: Record<never, never>;
  SaveSucceeded: {
    readonly checking: boolean;
    readonly status: SettingStatus;
    /** The value that was saved; the server echoes it as `setting`. */
    readonly value: boolean;
  };
  Toggled: { readonly value: boolean };
}>;

export const Evt = Data.taggedEnum<SettingsEvent>();

const checkMark = (status: SettingStatus): string =>
  `${status.checkedAt ?? ""}|${status.latest ?? ""}`;

/** Identity of one server answer: everything the card renders from it. */
const statusKey = (status: SettingStatus): string =>
  `${String(status.setting)}|${String(status.locked)}|${status.lockReason ?? ""}|${checkMark(status)}`;

/** The one constructor. */
export const stateFromStatus = (status: SettingStatus): SettingsState => {
  if (status.locked) {
    return Settings.Locked({
      reason: status.lockReason,
      stored: status.setting,
    });
  }

  return Settings.Ready({
    baseline: status.setting,
    check: "idle",
    checkMark: checkMark(status),
    draft: status.setting,
    error: null,
    save: "idle",
    seen: statusKey(status),
    stored: status.setting,
  });
};

/** The one transition. `Toggle` is ignored while a save is in flight (so a
 * click cannot race the request it would contradict), and every event that
 * changes the draft clears the confirmation. */
export const transition = (
  state: SettingsState,
  event: SettingsEvent
): SettingsState => {
  switch (event._tag) {
    case "LoadFailed": {
      return Settings.Failed({ message: event.message });
    }

    case "Loaded": {
      const next = stateFromStatus(event.status);

      if (state._tag !== "Ready" || next._tag !== "Ready") {
        return next;
      }

      // Keep the in-flight confirmation across the refetch that follows a
      // save, unless someone else changed the stored value meanwhile.
      const sameValue = next.stored === state.baseline;

      return Settings.Ready({
        ...next,
        baseline: state.baseline,
        check:
          state.check === "running" && next.checkMark === state.checkMark
            ? "running"
            : "idle",
        checkMark: state.checkMark,
        save: sameValue ? state.save : "idle",
      });
    }

    case "SaveFailed": {
      return state._tag === "Ready"
        ? Settings.Ready({ ...state, error: event.message, save: "error" })
        : state;
    }

    case "SaveStarted": {
      return state._tag === "Ready"
        ? Settings.Ready({ ...state, error: null, save: "saving" })
        : state;
    }

    case "SaveSucceeded": {
      if (state._tag !== "Ready") {
        return state;
      }

      return Settings.Ready({
        baseline: event.value,
        check: event.checking ? "running" : "idle",
        checkMark: event.checking ? checkMark(event.status) : "",
        draft: event.value,
        error: null,
        save: "saved",
        seen: statusKey(event.status),
        stored: event.value,
      });
    }

    default: {
      if (state._tag !== "Ready" || state.save === "saving") {
        return state;
      }

      return Settings.Ready({
        ...state,
        check: "idle",
        draft: event.value,
        error: null,
        save: "idle",
      });
    }
  }
};

/** Fold one render's server answer into the machine. A present status is a
 * `Loaded`; a blanked status (the refetch that follows a save) leaves the
 * machine alone; a failed first load becomes `Failed` instead of a skeleton
 * that never ends. Pure, so cards can compute the model at render time
 * without writing an atom. */
export const syncStatus = (
  state: SettingsState,
  status: SettingStatus | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- resource().error is unknown by contract
  error: unknown
): SettingsState => {
  if (status !== undefined) {
    // The same answer as last render is already folded in: folding it again
    // would reset the checkbox (and the error/check sub-state) on every
    // click.
    return state._tag === "Ready" && state.seen === statusKey(status)
      ? state
      : transition(state, Evt.Loaded({ status }));
  }

  if (error !== undefined && state._tag === "Loading") {
    return transition(state, Evt.LoadFailed({ message: errorMessage(error) }));
  }

  return state;
};
