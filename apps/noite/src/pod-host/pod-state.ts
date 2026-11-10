//! The pod server's own lifecycles: the pod itself, the one push the page may
//! have in flight, and the shell. One state each, one transition function.

import { Data } from "effect";

import type { FrameWorkspace } from "../lib/source/workspace/workspace";
import type { TerminalBackend } from "./terminal-backend";

/** The pod the frame serves.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> closed
 *   closed --> booting: open
 *   booting --> open: boot resolved
 *   booting --> closed: boot failed
 *   open --> closing: close
 *   closing --> closed: close resolved
 *   closed --> closed: requests refused
 * ```
 *
 * The open workspace lives *inside* the state, so "there is a workspace" and
 * "the pod is open" cannot disagree; every request that needs one reads the
 * state rather than a separate nullable variable. */
export type PodPhase = Data.TaggedEnum<{
  Closed: Record<never, never>;
  /** The boot attempt in flight; it settles when the attempt ends, either
   * way (a boot that failed moves the phase to `closed` itself). */
  Booting: { boot: Promise<void> };
  Open: { workspace: FrameWorkspace };
  Closing: Record<never, never>;
}>;

export type PodEvent =
  | { t: "boot-failed" }
  | { t: "booted"; workspace: FrameWorkspace }
  | { t: "close" }
  | { t: "closed" }
  | { t: "open"; boot: Promise<void> };

export const Pod = Data.taggedEnum<PodPhase>();

/** The one pod transition. A request that arrives mid-boot or mid-close leaves
 * the state alone (and the handler refuses it), so the phase cannot be
 * skipped. */
export const podTransition = (phase: PodPhase, event: PodEvent): PodPhase =>
  Pod.$match(phase, {
    Booting: () => {
      switch (event.t) {
        case "boot-failed": {
          return Pod.Closed();
        }

        case "booted": {
          return Pod.Open({ workspace: event.workspace });
        }

        case "close": {
          return Pod.Closing();
        }

        default: {
          return phase;
        }
      }
    },
    Closed: () =>
      event.t === "open" ? Pod.Booting({ boot: event.boot }) : phase,
    Closing: () => (event.t === "closed" ? Pod.Closed() : phase),
    Open: () => (event.t === "close" ? Pod.Closing() : phase),
  });

/** Where the one push the page may have in flight is.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> idle
 *   idle --> prepared: push.prepare
 *   prepared --> handed: payload reached the page
 *   handed --> settling: push.settle ok
 *   handed --> refused: push.settle failed
 *   settling --> idle: continuation finished
 *   refused --> idle: continuation finished
 *   prepared --> idle: lease expired
 *   handed --> idle: lease expired
 * ```
 *
 * `prepared` is the window before the payload is handed over (the facade is
 * still building it); `handed` is the page committing; `settling` is the
 * facade marking the commit pushed. `idle` is the only state in which another
 * push may start, and the lease is what guarantees the frame comes back to it
 * even when the page never settles. */
export type PushState = Data.TaggedEnum<{
  Handed: { lease: number };
  Idle: Record<never, never>;
  Prepared: { lease: number };
  Refused: { lease: number };
  Settling: { lease: number };
}>;

export type PushEvent =
  | { t: "abandon" }
  | { t: "finish" }
  | { lease: number; t: "hand" }
  | { lease: number; t: "prepare" }
  | { lease: number; t: "refuse" }
  | { lease: number; t: "settle" };

export const Push = Data.taggedEnum<PushState>();

/** The one push transition. Events that do not fit the current state leave it
 * alone; the handlers turn that into the wire's own refusal (`busy`,
 * `bad-params`). */
export const pushTransition = (state: PushState, event: PushEvent): PushState =>
  Push.$match(state, {
    Handed: ({ lease }) => {
      switch (event.t) {
        case "abandon": {
          return Push.Idle();
        }

        case "refuse": {
          return event.lease === lease ? Push.Refused({ lease }) : state;
        }

        case "settle": {
          return event.lease === lease ? Push.Settling({ lease }) : state;
        }

        default: {
          return state;
        }
      }
    },
    Idle: () =>
      event.t === "prepare" ? Push.Prepared({ lease: event.lease }) : state,
    Prepared: ({ lease }) => {
      switch (event.t) {
        case "abandon": {
          return Push.Idle();
        }

        case "hand": {
          return event.lease === lease ? Push.Handed({ lease }) : state;
        }

        default: {
          return state;
        }
      }
    },
    Refused: () => (event.t === "finish" ? Push.Idle() : state),
    Settling: () => (event.t === "finish" ? Push.Idle() : state),
  });

/** How long the page has to settle a push it was handed the payload for. The
 * page's own commit POST is bounded by the action middleware (15 s), so this
 * is many times the honest answer; past it the commit's outcome is unknown and
 * the pod must not hold the push slot for the frame's whole life. */
export const PUSH_LEASE_MS = 120_000;

/** The one timer a push needs, injectable so a test can expire the lease
 * without waiting on it. */
export interface PushLease {
  /** Run `expire` after the deadline; the returned function cancels it. */
  after: (expire: () => void) => () => void;
}

export const defaultPushLease = (): PushLease => ({
  after: (expire) => {
    const timer = setTimeout(expire, PUSH_LEASE_MS);

    return () => {
      clearTimeout(timer);
    };
  },
});

/** The frame's shell.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> closed
 *   closed --> open: terminal.open (a new session)
 *   open --> open: terminal.open (replaces the session)
 *   open --> closed: terminal.close
 *   open --> closed: workspace closed
 * ```
 *
 * Input and resize are only applied while `open`: a keystroke that races a
 * `terminal.open` is refused by the transition instead of being handed to a
 * shell that does not exist yet. */
export type TerminalState = Data.TaggedEnum<{
  Closed: Record<never, never>;
  Open: {
    backend: TerminalBackend;
    cols: number;
    rows: number;
    sessionId: number;
  };
}>;

export type TerminalEvent =
  | {
      backend: TerminalBackend;
      cols: number;
      rows: number;
      sessionId: number;
      t: "open";
    }
  | { cols: number; rows: number; t: "resize" }
  | { t: "close" };

export const Terminal = Data.taggedEnum<TerminalState>();

/** The one shell transition. Opening replaces the previous session (the page
 * only ever holds one). */
export const terminalTransition = (
  state: TerminalState,
  event: TerminalEvent
): TerminalState => {
  switch (event.t) {
    case "close": {
      return Terminal.Closed();
    }

    case "open": {
      return Terminal.Open({
        backend: event.backend,
        cols: event.cols,
        rows: event.rows,
        sessionId: event.sessionId,
      });
    }

    case "resize": {
      return Terminal.$is("Open")(state)
        ? Terminal.Open({
            ...state,
            cols: event.cols,
            rows: event.rows,
          })
        : state;
    }

    default: {
      return state;
    }
  }
};
