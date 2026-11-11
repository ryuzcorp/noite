//! Admin app runtime: the runner's `status` × `desiredState` collapsed into
//! the four states the admin Apps panel acts on. The lifecycle is the app
//! header's own (`./lifecycle`: `appLifecycle`/`APP_FACTS`), so the admin's
//! Start/Stop can never disagree with the app page about what an app is doing;
//! this module only folds that union into the panel's coarser view.
//!
//! | state           | means                                   | next action |
//! | --------------- | --------------------------------------- | ----------- |
//! | `Running`       | settled at desired=running (incl. asleep, or held) | stop |
//! | `Stopped`       | settled at desired=stopped              | start       |
//! | `Transitioning` | desired != status, and a toggle settles it | the opposite |
//! | `Unknown`       | no toggle: import, failed, never deployed, no desired | none |
//!
//! `next` is null exactly for the states with no meaningful action, so the
//! panel can never send a start to an app that is already running (the old
//! `desiredState === "" ? "Start"` default did exactly that).
import { Data } from "effect";

import { appLifecycle } from "../app-detail/lifecycle";
import type { AppStatusPage } from "../app-detail/lifecycle";

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

/** The one constructor for the admin panel's view of an app. The lifecycle
 * decides: a live (or crash-held) fleet is running, a settled stop is
 * stopped, and only an app with a meaningful Start/Stop is transitional. An
 * import or a never-deployed app offers neither (the header retries imports),
 * and an app whose desired state the wire omitted is unknown. */
export const runtimeOf = (app: AppStatusPage): AppRuntime => {
  if (app.desiredState !== "running" && app.desiredState !== "stopped") {
    return Runtime.Unknown();
  }

  const lifecycle = appLifecycle(app);

  switch (lifecycle._tag) {
    case "Live":
    case "Held": {
      return Runtime.Running();
    }

    case "Stopped": {
      return Runtime.Stopped();
    }

    case "NeverDeployed":
    case "Importing":
    case "ImportFailed":
    case "Failed": {
      return Runtime.Unknown();
    }

    case "Deploying":
    case "Starting":
    case "Stopping":
    case "Unknown": {
      return Runtime.Transitioning({ to: app.desiredState });
    }

    default: {
      // A new lifecycle tag must fail to compile here instead of offering a
      // button the app header would not.
      const unhandled: never = lifecycle;

      return unhandled;
    }
  }
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
