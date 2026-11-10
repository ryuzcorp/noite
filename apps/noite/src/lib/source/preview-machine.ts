//! The Preview panel's lifecycles, as values: what the frame is doing, how
//! fresh the snapshot is against the checkout, what the deploy button is in the
//! middle of, and what the address field holds.

import { Data } from "effect";

/** The iframe's own liveness, per reload token.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> loading: mount, reload, or a deploy went live
 *   loading --> live: the frame's load event
 *   loading --> stalled: LOAD_TIMEOUT_MS passed
 *   live --> loading: a new token
 *   stalled --> loading: a new token (a deploy, or Retry)
 * ```
 *
 * The token is the successful deploy's id plus the reload count: every
 * transition names the token it belongs to, so a load event for an older
 * navigation cannot mark a newer one live, and a deploy that lands while the
 * frame is `stalled` moves it back to `loading` on its own (the old booleans
 * left the iframe unmounted and the viewer had to press Retry). */
export type PreviewFrameState = Data.TaggedEnum<{
  Live: { token: string };
  Loading: { token: string };
  Stalled: { token: string };
}>;

export type PreviewFrameEvent =
  | { t: "arm"; token: string }
  | { t: "loaded"; token: string }
  | { t: "timeout"; token: string };

export const PreviewFrame = Data.taggedEnum<PreviewFrameState>();

/** The one frame transition. An event for another token leaves the state
 * alone. */
export const previewFrameTransition = (
  state: PreviewFrameState,
  event: PreviewFrameEvent
): PreviewFrameState => {
  switch (event.t) {
    case "arm": {
      return PreviewFrame.Loading({ token: event.token });
    }

    case "loaded": {
      return PreviewFrame.$match(state, {
        Live: () => state,
        Loading: ({ token }) =>
          token === event.token ? PreviewFrame.Live({ token }) : state,
        Stalled: ({ token }) =>
          token === event.token ? PreviewFrame.Live({ token }) : state,
      });
    }

    default: {
      return PreviewFrame.$match(state, {
        Live: () => state,
        Loading: ({ token }) =>
          token === event.token ? PreviewFrame.Stalled({ token }) : state,
        Stalled: () => state,
      });
    }
  }
};

/** How much of the checkout a framed workspace preview holds.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> none: no workspace preview is deployed
 *   [*] --> unknown: deployed, but no snapshot was recorded
 *   none --> fresh: a deploy snapshotted these changes
 *   unknown --> fresh: same
 *   fresh --> behind: an edit landed after the deploy
 *   behind --> fresh: another deploy
 * ```
 *
 * `behind` counts the edits the snapshot does not hold, so the panel can say
 * *how many* changes are missing instead of a bare warning. */
export type PreviewFreshnessState = Data.TaggedEnum<{
  Behind: { changes: number };
  Fresh: Record<never, never>;
  None: Record<never, never>;
  Unknown: Record<never, never>;
}>;

export const PreviewFreshness = Data.taggedEnum<PreviewFreshnessState>();

/** The freshness of a workspace preview: `snapshotted` is the fingerprint the
 * last deploy recorded, `current` the checkout's now. */
export const previewFreshness = (input: {
  changes: number;
  current: string;
  snapshotted: string | null;
}): PreviewFreshnessState => {
  const { changes, current, snapshotted } = input;

  if (snapshotted === null) {
    return changes === 0 ? PreviewFreshness.None() : PreviewFreshness.Unknown();
  }

  return snapshotted === current
    ? PreviewFreshness.Fresh()
    : PreviewFreshness.Behind({ changes });
};

/** The Deploy preview button's own state.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> idle
 *   idle --> snapshotting: the click
 *   snapshotting --> done: the runner accepted the environment
 *   snapshotting --> failed: the request refused
 *   failed --> snapshotting: retry
 * ```
 *
 * `snapshotting` is what keeps a second click from deploying twice, and it is
 * one value instead of a `deploying` atom plus an `attempted` one that could
 * disagree across a remount. */
export type DeployState = Data.TaggedEnum<{
  Done: Record<never, never>;
  Failed: { message: string };
  Idle: Record<never, never>;
  Snapshotting: Record<never, never>;
}>;

export type DeployEvent =
  | { message: string; t: "failed" }
  | { t: "succeeded" }
  | { t: "submit" };

export const Deploy = Data.taggedEnum<DeployState>();

/** The one deploy transition: only `idle` and `failed` may submit. */
export const deployTransition = (
  state: DeployState,
  event: DeployEvent
): DeployState => {
  switch (event.t) {
    case "failed": {
      return Deploy.$is("Snapshotting")(state)
        ? Deploy.Failed({ message: event.message })
        : state;
    }

    case "succeeded": {
      return Deploy.$is("Snapshotting")(state) ? Deploy.Done() : state;
    }

    default: {
      return Deploy.$match(state, {
        Done: () => Deploy.Snapshotting(),
        Failed: () => Deploy.Snapshotting(),
        Idle: () => Deploy.Snapshotting(),
        Snapshotting: () => state,
      });
    }
  }
};

/** What the address field holds: the loaded address, what the viewer typed,
 * and whether the last submit named nothing navigable. */
export type AddressEdit = Data.TaggedEnum<{
  Display: Record<never, never>;
  Editing: { text: string };
  Invalid: { text: string };
}>;

export type AddressEvent =
  | { t: "blur" }
  | { t: "clear" }
  | { text: string; t: "type" }
  | { text: string; t: "invalid" }
  | { t: "navigate" };

export const Address = Data.taggedEnum<AddressEdit>();

/** The one address-field transition. `navigate` puts the field back to
 * `display` (the loaded address is what it shows). */
export const addressTransition = (
  state: AddressEdit,
  event: AddressEvent
): AddressEdit => {
  switch (event.t) {
    case "blur":
    case "clear":
    case "navigate": {
      return Address.Display();
    }

    case "invalid": {
      return Address.Invalid({ text: event.text });
    }

    default: {
      return Address.Editing({ text: event.text });
    }
  }
};
