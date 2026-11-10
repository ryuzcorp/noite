//! The frame's own handshake state: inert, listening, bound — and what each
//! message may do to it.

import { Data } from "effect";

import { POD_PROTOCOL_VERSION } from "../lib/source/pod-protocol";
import type { PodBound } from "../lib/source/pod-protocol";
import type { PodAddress } from "./handshake";

/** Why the frame serves nothing. `unframed` is a document nobody opened as a
 * pod host (the top-level page, a URL missing its nonce); `broken` is a bind
 * that threw, which the page must learn about rather than wait on. */
export type FrameBrokenReason = "broken" | "unframed";

/** The frame's state.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> inert
 *   inert --> listening: serve (valid address)
 *   listening --> listening: hello (answer again)
 *   listening --> bound: connect (nonce matches)
 *   listening --> broken: bind threw
 * ```
 *
 * The `hello` listener and the `connect` listener are the same one here (the
 * `listening` state is what answers `hello`); a second `connect` is refused by
 * the transition rather than by removing the listener, so "already bound" is
 * a readable state instead of a missing callback. */
export type FrameState = Data.TaggedEnum<{
  /** Not framed, or opened without the URL fields the control writes. */
  Inert: { reason: FrameBrokenReason };
  /** Bound to the page's port; nothing else may bind it. */
  Bound: { nonce: string };
  /** Answering the handshake, waiting for the port. */
  Listening: { address: PodAddress };
  /** A bind that threw: nothing will ever answer on this document. */
  Broken: { reason: string };
}>;

/** What the frame receives. */
export type FrameEvent =
  | { t: "bind" }
  | { t: "bind-failed"; error: string }
  | { t: "hello" }
  | { t: "invalid" }
  | { t: "serve"; address: PodAddress };

export const Frame = Data.taggedEnum<FrameState>();

/** The one transition. `hello` is answered in `Listening` only (the state
 * that owns the listener); `bind` is legal once; anything else is refused by
 * returning the state unchanged, so a race between two `connect` messages
 * cannot produce a second bind. */
export const frameTransition = (
  state: FrameState,
  event: FrameEvent
): FrameState =>
  Frame.$match(state, {
    Bound: () => state,
    Broken: () => state,
    Inert: () =>
      event.t === "serve" ? Frame.Listening({ address: event.address }) : state,
    Listening: ({ address }) => {
      switch (event.t) {
        case "bind": {
          return Frame.Bound({ nonce: address.nonce });
        }

        case "bind-failed": {
          return Frame.Broken({ reason: event.error });
        }

        default: {
          return state;
        }
      }
    },
  });

/** The `bound` ack the page waits for (see `pod-protocol.ts`). */
export const boundMessage = (nonce: string): PodBound => ({
  nonce,
  t: "bound",
  v: POD_PROTOCOL_VERSION,
});
