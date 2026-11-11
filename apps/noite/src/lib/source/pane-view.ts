//! The open file in the code pane: one closed value per open, so the
//! placeholder, the spinner, the paint and the failure note cannot disagree.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Empty
//!   Empty --> Reading: Requested{path}
//!   Reading --> Ready: Resolved{token, painted}
//!   Reading --> Failed: Failed{token, path}
//!   Reading --> Reading: Requested{other path}   (the last paint stays)
//!   Ready --> Reading: Requested{path}           (the last paint stays)
//!   Failed --> Reading: Requested{path}
//!   Ready --> Empty: Closed
//!   Failed --> Empty: Closed
//! ```
//!
//! A `Resolved` or `Failed` is refused unless its token is the one the current
//! read was started with: a superseded blob read never paints over the file
//! the user opened after it.

import { Data } from "effect";

/** What the pane shows of one file. */
export interface PanePainted {
  /** Whether the file may be edited (a text file on an editable checkout). */
  editable: boolean;
  /** The path the paint belongs to. */
  path: string;
  /** The note that stands in for the text, when there is no text to show. */
  placeholder: string | null;
  /** The committed text, or "" when `placeholder` is set. */
  text: string;
}

/** The pane's own state. */
export type PaneView = Data.TaggedEnum<{
  Closed: Record<never, never>;
  Failed: { message: string; path: string };
  Reading: { path: string; token: number };
  Ready: { painted: PanePainted };
}>;

export const PaneViews = Data.taggedEnum<PaneView>();

/** The token a read is started with, and the value it resolves against. */
export interface ReadTicket {
  path: string;
  token: number;
}

/** The pane's machine: the view and the token counter are the whole state. */
export interface PaneMachine {
  seq: number;
  view: PaneView;
}

export const newPaneMachine = (): PaneMachine => ({
  seq: 0,
  view: PaneViews.Closed(),
});

/** What the pane has painted, when it holds a file. */
export const paintedOf = (state: PaneView): PanePainted | null =>
  state._tag === "Ready" ? state.painted : null;

/** The path the pane is responsible for: the open one, or the one being read. */
export const panePath = (state: PaneView): string | null => {
  if (state._tag === "Ready") {
    return state.painted.path;
  }

  if (state._tag === "Reading" || state._tag === "Failed") {
    return state.path;
  }

  return null;
};

/** What the browser reports to the machine. */
export type PaneEvent = Data.TaggedEnum<{
  Closed: Record<never, never>;
  Failed: { message: string; ticket: ReadTicket };
  Requested: { path: string };
  Resolved: { painted: PanePainted; ticket: ReadTicket };
}>;

export const PaneEvents = Data.taggedEnum<PaneEvent>();

/** One transition: the machine's new state, and the ticket a `Requested`
 * started (null for every other event). */
export interface PaneDecision {
  machine: PaneMachine;
  read: ReadTicket | null;
  refused: boolean;
}

const refuse = (machine: PaneMachine): PaneDecision => ({
  machine,
  read: null,
  refused: true,
});

/** One event, one state. */
export const stepPane = (
  machine: PaneMachine,
  event: PaneEvent
): PaneDecision => {
  if (event._tag === "Requested") {
    const seq = machine.seq + 1;
    const ticket = { path: event.path, token: seq };

    return {
      machine: { seq, view: PaneViews.Reading(ticket) },
      read: ticket,
      refused: false,
    };
  }

  if (event._tag === "Resolved") {
    if (
      machine.view._tag !== "Reading" ||
      machine.view.token !== event.ticket.token
    ) {
      return refuse(machine);
    }

    return {
      machine: {
        seq: machine.seq,
        view: PaneViews.Ready({ painted: event.painted }),
      },
      read: null,
      refused: false,
    };
  }

  if (event._tag === "Failed") {
    if (
      machine.view._tag !== "Reading" ||
      machine.view.token !== event.ticket.token
    ) {
      return refuse(machine);
    }

    return {
      machine: {
        seq: machine.seq,
        view: PaneViews.Failed({
          message: event.message,
          path: event.ticket.path,
        }),
      },
      read: null,
      refused: false,
    };
  }

  if (machine.view._tag === "Closed") {
    return refuse(machine);
  }

  return {
    machine: { seq: machine.seq, view: PaneViews.Closed() },
    read: null,
    refused: false,
  };
};
