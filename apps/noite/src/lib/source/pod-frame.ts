//! The page's side of the pod frame handshake, as one state.

import { Data } from "effect";

import type { PodReady } from "./pod-protocol";

/** Why the page never got a live frame. Each reason is a different thing to
 * say: the host never answered, it answered but cannot run a pod, or it
 * answered and never took the port. */
export type FrameFailureReason = "isolation" | "timeout" | "unbound";

/** The state of the frame the page opened.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> idle
 *   idle --> loading: mount (frame appended)
 *   loading --> loading: load (retry reload)
 *   loading --> answered: ready (nonce + version)
 *   loading --> failed: deadline
 *   answered --> failed: not isolated
 *   answered --> connected: bound (frame ack)
 *   answered --> failed: bind deadline
 *   connected --> [*]
 *   failed --> [*]
 * ```
 *
 * `connected` is only reachable from `answered` *and* through the frame's own
 * `PodBound`, so "the port was posted" can never be mistaken for "the frame
 * is listening on it". `connected` and `failed` are terminal: a late message
 * after either changes nothing. */
export type FrameState = Data.TaggedEnum<{
  /** Nothing opened yet. */
  Idle: Record<never, never>;
  /** The frame is in the document; `attempts` counts its loads. */
  Loading: { attempts: number };
  /** The frame answered the handshake and passed the origin checks. */
  Answered: { ready: PodReady };
  /** The frame proved it bound the port it was handed. */
  Connected: Record<never, never>;
  /** The frame will never connect; `reason` is what to tell the user. */
  Failed: { reason: FrameFailureReason };
}>;

/** What happens to the frame: the page's own timers and the frame's
 * messages. */
export type FrameEvent =
  | { t: "bound" }
  | { t: "deadline" }
  | { t: "load" }
  | { t: "mount" }
  | { t: "not-isolated" }
  | { t: "ready"; ready: PodReady }
  | { t: "unbound" };

export const Frame = Data.taggedEnum<FrameState>();

/** The one transition. An event that makes no sense for the current state
 * leaves it as it is, which is what keeps a late `ready` (after the deadline)
 * or a second `bound` from moving a settled frame. */
export const frameTransition = (
  state: FrameState,
  event: FrameEvent
): FrameState =>
  Frame.$match(state, {
    Answered: () => {
      switch (event.t) {
        case "bound": {
          return Frame.Connected();
        }

        case "not-isolated": {
          return Frame.Failed({ reason: "isolation" });
        }

        case "unbound": {
          return Frame.Failed({ reason: "unbound" });
        }

        default: {
          return state;
        }
      }
    },
    Connected: () => state,
    Failed: () => state,
    Idle: () => (event.t === "mount" ? Frame.Loading({ attempts: 1 }) : state),
    Loading: ({ attempts }) => {
      switch (event.t) {
        case "deadline": {
          return Frame.Failed({ reason: "timeout" });
        }

        case "load": {
          return Frame.Loading({ attempts: attempts + 1 });
        }

        case "ready": {
          return Frame.Answered({ ready: event.ready });
        }

        default: {
          return state;
        }
      }
    },
  });

/** The one thing to say for a failed frame, per reason. The messages name the
 * origin and what to do, because "reload" is the only recovery the page has. */
const FRAME_FAILURE_MESSAGE = {
  isolation: (previewOrigin: string): string =>
    `Pod host ${previewOrigin} is not cross-origin isolated, so the workspace cannot run with SharedArrayBuffer`,
  timeout: (previewOrigin: string): string =>
    `Could not start the workspace: the pod host at ${previewOrigin} did not answer. Reload the page to try again.`,
  unbound: (previewOrigin: string): string =>
    `Pod host ${previewOrigin} answered but never took the workspace port. Reload the page to try again.`,
} satisfies Record<FrameFailureReason, (previewOrigin: string) => string>;

export const frameFailureMessage = (
  reason: FrameFailureReason,
  previewOrigin: string
): string => FRAME_FAILURE_MESSAGE[reason](previewOrigin);
