//! The editor pane's surface: what the code column shows, which file owns it,
//! and which read is allowed to paint it. One value plus one token counter, so
//! `?file=`, the tree's selection and the painted document cannot disagree —
//! and a read that started before the surface moved on is refused instead of
//! landing late.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Empty
//!   Empty --> Opening: Requested{path}
//!   Opening --> Painted: Resolved{token,show}
//!   Opening --> Failed: OpenFailed{token,message}
//!   Opening --> Painted: Abandoned        (nothing to show)
//!   Painted --> Opening: Requested{path} / SyncStarted{path,!writing}
//!   Painted --> Stale: Rebased            (text stays, ownership does not)
//!   Painted --> Empty: Dropped
//!   Stale --> Opening: Requested{path}
//!   Stale --> Empty: Dropped
//! ```
//!
//! `Opening` is also what the pane shows while one of its own writes is in
//! flight (a `SyncStarted` for a file with a pending write is answered without
//! a read, so the in-flight open it belongs to is never cancelled).

import { Data } from "effect";

/** A file the pane has painted: the surface's own description of it. */
export interface PaintedView {
  /** The committed text, because the pod no longer holds the file (a staged
   * deletion): read-only. */
  readonly committedOnly: boolean;
  readonly editable: boolean;
  readonly path: string;
  /** The placeholder a binary or oversize file shows instead of text. */
  readonly placeholder: string | null;
  /** The text the surface holds: what a re-read is compared against. */
  readonly text: string;
  readonly token: number;
}

/** What the pane shows. */
export type PaneView = Data.TaggedEnum<{
  /** Nothing: the pane was dropped, or never painted. */
  Empty: Record<never, never>;
  /** `path` is being read; `from` is what the surface showed meanwhile. */
  Opening: { from: PaintedView | null; path: string; token: number };
  /** The pod's own text (or its placeholder) for `path`. */
  Painted: PaintedView;
  /** The checkout under the pane changed: the surface still shows `view`'s
   * text, but it belongs to the old ref and no path owns it. */
  Stale: { view: PaintedView };
  /** The read failed: the pane shows why. */
  Failed: { message: string; path: string; token: number };
}>;

export const PaneViews = Data.taggedEnum<PaneView>();

/** The pane's state and the token every read is stamped with. */
export interface PaneMachine {
  /** The last token handed out. Monotonic: a read answers for its own token
   * or not at all. */
  readonly seq: number;
  readonly view: PaneView;
}

export const newPaneMachine = (): PaneMachine => ({
  seq: 0,
  view: PaneViews.Empty(),
});

/** What the surface really shows, for the paint and the `?file=` write. */
export const paintedOf = (state: PaneView): PaintedView | null => {
  if (state._tag === "Painted") {
    return state;
  }

  if (state._tag === "Stale") {
    return state.view;
  }

  if (state._tag === "Opening") {
    return state.from;
  }

  return null;
};

/** The path the pane is responsible for (the one `?file=` may name), or null
 * while nothing is open. A `Stale` surface belongs to no path. */
export const panePath = (state: PaneView): string | null => {
  if (state._tag === "Painted") {
    return state.path;
  }

  if (state._tag === "Opening") {
    return state.path;
  }

  if (state._tag === "Failed") {
    return state.path;
  }

  return null;
};

/** What an open resolved to. */
export interface ResolvedShow {
  readonly committedOnly: boolean;
  readonly editable: boolean;
  readonly path: string;
  readonly placeholder: string | null;
  readonly text: string;
}

/** What the caller must do after a transition. */
export interface PaneDecision {
  /** Blank the surface (the open file is gone, or the pane was dropped). */
  readonly close: boolean;
  /** The read that must answer with `Resolved`/`OpenFailed` for this token. */
  readonly read: { readonly path: string; readonly token: number } | null;
  /** The event was refused; the machine is unchanged. */
  readonly refused: boolean;
  /** The pane already shows exactly this: ask the intelligence layer to
   * re-check it instead of repainting. */
  readonly recheck: boolean;
  readonly machine: PaneMachine;
}

/** What the pane is asked to do. */
export type PaneEvent = Data.TaggedEnum<{
  /** The read found nothing to show: the surface goes back to what it held. */
  Abandoned: Record<never, never>;
  /** Close the open file without reopening it. */
  Dropped: Record<never, never>;
  /** A move carried the open path off. */
  Moved: { from: string; to: string };
  /** The read for `token` failed. */
  OpenFailed: { message: string; path: string; token: number };
  /** The checkout under the pane changed. */
  Rebased: Record<never, never>;
  /** Open `path` (a click, a deep link, a move). */
  Requested: { path: string };
  /** The read for `token` landed. */
  Resolved: { show: ResolvedShow; token: number };
  /** The pod moved: open the same path again, unless a write of the pane's own
   * is in flight (the read would answer with bytes older than the editor). */
  SyncStarted: { path: string; writing: boolean };
}>;

export const PaneEvents = Data.taggedEnum<PaneEvent>();

const refuse = (machine: PaneMachine): PaneDecision => ({
  close: false,
  machine,
  read: null,
  recheck: false,
  refused: true,
});

const settle = (
  machine: PaneMachine,
  view: PaneView,
  close: boolean
): PaneDecision => ({
  close,
  machine: { seq: machine.seq, view },
  read: null,
  recheck: false,
  refused: false,
});

const beginRead = (machine: PaneMachine, path: string): PaneDecision => {
  const token = machine.seq + 1;

  return {
    close: false,
    machine: {
      seq: token,
      view: PaneViews.Opening({ from: paintedOf(machine.view), path, token }),
    },
    read: { path, token },
    recheck: false,
    refused: false,
  };
};

/** The pod moved under a painted file: re-read it, unless its own write is
 * still landing (the read would be older than the editor). An open already in
 * flight owns the surface: cancelling it is what used to leave `?file=` naming
 * a file nothing ever painted. */
const syncStarted = (
  machine: PaneMachine,
  event: { readonly path: string; readonly writing: boolean }
): PaneDecision => {
  const { view } = machine;

  if (view._tag === "Opening") {
    return {
      close: false,
      machine,
      read: null,
      recheck: false,
      refused: false,
    };
  }

  if (view._tag !== "Painted" || view.path !== event.path) {
    return refuse(machine);
  }

  if (event.writing) {
    return {
      close: false,
      machine,
      read: null,
      recheck: true,
      refused: false,
    };
  }

  return beginRead(machine, event.path);
};

const resolved = (
  machine: PaneMachine,
  event: { readonly show: ResolvedShow; readonly token: number }
): PaneDecision => {
  const { view } = machine;

  if (view._tag !== "Opening" || view.token !== event.token) {
    return refuse(machine);
  }

  const { show } = event;

  return settle(
    machine,
    PaneViews.Painted({
      committedOnly: show.committedOnly,
      editable: show.editable,
      path: show.path,
      placeholder: show.placeholder,
      text: show.text,
      token: event.token,
    }),
    false
  );
};

const openFailed = (
  machine: PaneMachine,
  event: {
    readonly message: string;
    readonly path: string;
    readonly token: number;
  }
): PaneDecision => {
  const { view } = machine;

  if (view._tag !== "Opening" || view.token !== event.token) {
    return refuse(machine);
  }

  return {
    close: false,
    machine: {
      seq: machine.seq,
      view: PaneViews.Failed({
        message: event.message,
        path: event.path,
        token: event.token,
      }),
    },
    read: null,
    recheck: false,
    refused: false,
  };
};

const moved = (
  machine: PaneMachine,
  event: { readonly from: string; readonly to: string }
): PaneDecision => {
  const { from, to } = event;

  const move = (path: string): string =>
    path === from || path.startsWith(`${from}/`)
      ? `${to}${path.slice(from.length)}`
      : path;

  const { view } = machine;

  if (view._tag === "Painted") {
    return settle(
      machine,
      PaneViews.Painted({ ...view, path: move(view.path) }),
      false
    );
  }

  if (view._tag === "Opening") {
    return settle(
      machine,
      PaneViews.Opening({
        ...view,
        from:
          view.from === null
            ? null
            : { ...view.from, path: move(view.from.path) },
        path: move(view.path),
      }),
      false
    );
  }

  if (view._tag === "Stale") {
    return settle(
      machine,
      PaneViews.Stale({ view: { ...view.view, path: move(view.view.path) } }),
      false
    );
  }

  return refuse(machine);
};

/** One transition of the pane's surface. */
export const stepPane = (
  machine: PaneMachine,
  event: PaneEvent
): PaneDecision => {
  const { view } = machine;

  if (event._tag === "Requested") {
    return beginRead(machine, event.path);
  }

  if (event._tag === "Abandoned") {
    if (view._tag !== "Opening") {
      return refuse(machine);
    }

    const back = view.from;

    return {
      close: false,
      machine: {
        seq: machine.seq + 1,
        view: back === null ? PaneViews.Empty() : PaneViews.Painted(back),
      },
      read: null,
      recheck: false,
      refused: false,
    };
  }

  if (event._tag === "SyncStarted") {
    return syncStarted(machine, event);
  }

  if (event._tag === "Resolved") {
    return resolved(machine, event);
  }

  if (event._tag === "OpenFailed") {
    return openFailed(machine, event);
  }

  if (event._tag === "Rebased") {
    const stale = paintedOf(view);

    const next =
      stale === null ? PaneViews.Empty() : PaneViews.Stale({ view: stale });

    return {
      close: false,
      machine: { seq: machine.seq + 1, view: next },
      read: null,
      recheck: false,
      refused: false,
    };
  }

  if (event._tag === "Dropped") {
    return {
      close: true,
      machine: { seq: machine.seq + 1, view: PaneViews.Empty() },
      read: null,
      recheck: false,
      refused: false,
    };
  }

  return moved(machine, event);
};
