//! Admin app runtime: the runner's `status` × `desiredState` collapsed into
//! the four states the admin Apps panel acts on. The runner owns the real
//! lifecycle (`AppStatus`/`DesiredState` in `apps/runner/src/models.rs`); this
//! is the control plane's thin consumer view, so the button label and the
//! "→ desired" suffix come from ONE union instead of two string comparisons.
//!
//! | state           | means                                   | next action |
//! | --------------- | --------------------------------------- | ----------- |
//! | `Running`       | settled at desired=running (incl. asleep) | stop      |
//! | `Stopped`       | settled at desired=stopped              | start       |
//! | `Transitioning` | desired != status, or a failed deploy   | none        |
//! | `Unknown`       | the runner omitted `desiredState`       | none        |
//!
//! `next` is null exactly for the states with no meaningful action, so the
//! panel can never send a start to an app that is already running (the old
//! `desiredState === "" ? "Start"` default did exactly that).
import { Data } from "effect";

export type AppRuntime = Data.TaggedEnum<{
  Running: Record<never, never>;
  Stopped: Record<never, never>;
  Transitioning: { readonly to: "running" | "stopped" };
  Unknown: Record<never, never>;
}>;

export const Runtime = Data.taggedEnum<AppRuntime>();

/** The wire tag the admin list sends (kebab-case of the union tag). */
export type AppRuntimeWire =
  | "running"
  | "stopped"
  | "transitioning"
  | "unknown";

export const runtimeWire = (runtime: AppRuntime): AppRuntimeWire =>
  // SAFETY: the four union tags lowercase to exactly their wire values.
  runtime._tag.toLowerCase() as AppRuntimeWire;

/** The runner `status` values that mean "settled at the desired state".
 * `sleeping` is scale-to-zero: healthy and desired running, parked until the
 * next request. */
const SETTLED_RUNNING = {
  running: true,
  sleeping: true,
} satisfies Record<string, true>;

/** Statuses that are settled but not at any start/stop target: a failed app or
 * one that was never deployed needs a deploy, not a toggle, so the panel
 * offers no action and stops polling it. Everything else is on its way
 * somewhere (running while a stop lands, building while a start does). */
const NEEDS_DEPLOY = {
  failed: true,
  provisioned: true,
} satisfies Record<string, true>;

/** The one constructor for the admin panel's view of an app. */
export const runtimeOf = (status: string, desiredState: string): AppRuntime => {
  if (desiredState === "stopped") {
    if (status === "stopped") {
      return Runtime.Stopped();
    }

    return status in NEEDS_DEPLOY
      ? Runtime.Unknown()
      : Runtime.Transitioning({ to: "stopped" });
  }

  if (desiredState === "running") {
    if (status in SETTLED_RUNNING) {
      return Runtime.Running();
    }

    return status in NEEDS_DEPLOY
      ? Runtime.Unknown()
      : Runtime.Transitioning({ to: "running" });
  }

  return Runtime.Unknown();
};

/** The action the panel may offer, or null when there is none. */
export const nextAction = (runtime: AppRuntime): "start" | "stop" | null => {
  switch (runtime._tag) {
    case "Running": {
      return "stop";
    }

    case "Stopped": {
      return "start";
    }

    case "Transitioning": {
      // The action that *changes the desired state*, not the one the current
      // fleet status implies. The runner accepts it idempotently, and it
      // keeps a moving row operable (a one-shot refetch used to leave the
      // button dead until the row happened to refresh).
      return runtime.to === "running" ? "stop" : "start";
    }

    default: {
      return null;
    }
  }
};

/** The `desiredState` an action sends. */
export const actionDesiredState = (
  action: "start" | "stop"
): "running" | "stopped" => (action === "start" ? "running" : "stopped");
