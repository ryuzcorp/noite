//! One comment's editor lifecycle, shared by the composer and the comment
//! card (and the pull request description).
//!
//! Each of those controls re-implemented the same `editing` + `draft` +
//! `busy` + `notice` atoms, and the draft was seeded once at mount, so a
//! remote edit was masked while the user had the card open, and Cancel left a
//! stale error under the read view. Here the state is one value and the draft
//! is seeded by the `edit` event from the comment's *current* text.
//!
//! ```text
//! Read ──edit{original}──▶ Editing ⇄ Read (cancel restores the original)
//! Editing ──submit (non-blank)──▶ Saving ──saved──▶ Read
//!                                        └──failed──▶ Failed ──edit/change──▶ Editing
//! Read/Editing ──deleteRequest──▶ DeleteConfirm ──deleteConfirm──▶ Deleting ──deleted──▶ Gone
//!                                       └──deleteCancel──▶ Read
//! Saving and Deleting refuse every edit and every cancel: the request in
//! flight always carries the text the user confirmed.
//! ```

import { Data } from "effect";

export type CommentState = Data.TaggedEnum<{
  /** Showing the text; no draft. */
  Read: Record<never, never>;
  /** Editing a draft (also the composer's resting state, with an empty one). */
  Editing: { readonly draft: string };
  /** A write is in flight. */
  Saving: { readonly draft: string };
  /** The last write failed; the draft stays for a retry. */
  Failed: {
    readonly draft: string;
    readonly message: string;
  };
  /** The delete is armed (an inline confirmation, not a browser dialog). */
  DeleteConfirm: Record<never, never>;
  /** A delete is in flight. */
  Deleting: Record<never, never>;
  /** The comment was deleted; the card unmounts. */
  Gone: Record<never, never>;
}>;

export const Comment = Data.taggedEnum<CommentState>();

/** The effect the component must perform. */
export type CommentEffect =
  | { readonly kind: "none" }
  | { readonly body: string; readonly kind: "save" }
  | { readonly kind: "delete" };

export interface CommentStep {
  readonly effect: CommentEffect;
  readonly state: CommentState;
}

export type CommentEvent =
  | { readonly kind: "edit"; readonly original: string }
  | { readonly draft: string; readonly kind: "change" }
  | { readonly kind: "submit" }
  | { readonly kind: "saved" }
  | { readonly message: string; readonly kind: "failed" }
  | { readonly kind: "cancel" }
  | { readonly kind: "deleteRequest" }
  | { readonly kind: "deleteConfirm" }
  | { readonly kind: "deleteCancel" }
  | { readonly kind: "deleted" };

/** The draft a state carries ("" when it has none). */
export const commentDraft = (state: CommentState): string => {
  switch (state._tag) {
    case "Editing":
    case "Saving":
    case "Failed": {
      return state.draft;
    }

    default: {
      return "";
    }
  }
};

/** The refusal step for a write in flight: `Saving`/`Deleting` only accept
 * their own completion, and return null for any other state. */
const inFlightStep = (
  state: CommentState,
  event: CommentEvent
): CommentStep | null => {
  if (state._tag === "Deleting") {
    if (event.kind === "deleted") {
      return { effect: { kind: "none" }, state: Comment.Gone() };
    }

    if (event.kind === "failed") {
      return {
        effect: { kind: "none" },
        state: Comment.Failed({ draft: "", message: event.message }),
      };
    }

    return { effect: { kind: "none" }, state };
  }

  if (state._tag === "Saving") {
    if (event.kind === "saved") {
      return { effect: { kind: "none" }, state: Comment.Read() };
    }

    if (event.kind === "failed") {
      return {
        effect: { kind: "none" },
        state: Comment.Failed({ draft: state.draft, message: event.message }),
      };
    }

    return { effect: { kind: "none" }, state };
  }

  return null;
};

/** Whether the editor is open (any state with a draft on screen). */
export const commentEditing = (state: CommentState): boolean => {
  switch (state._tag) {
    case "Editing":
    case "Saving":
    case "Failed": {
      return true;
    }

    default: {
      return false;
    }
  }
};

/** The one transition function for a comment editor. */
export const nextComment = (
  state: CommentState,
  event: CommentEvent
): CommentStep => {
  const inFlight = inFlightStep(state, event);

  if (inFlight !== null) {
    return inFlight;
  }

  switch (event.kind) {
    case "edit": {
      return {
        effect: { kind: "none" },
        state: Comment.Editing({ draft: event.original }),
      };
    }

    case "change": {
      if (state._tag !== "Editing" && state._tag !== "Failed") {
        return { effect: { kind: "none" }, state };
      }

      return {
        effect: { kind: "none" },
        state: Comment.Editing({ draft: event.draft }),
      };
    }

    case "submit": {
      const draft = commentDraft(state).trim();

      if (draft === "" || state._tag === "Read") {
        return { effect: { kind: "none" }, state };
      }

      return {
        effect: { body: draft, kind: "save" },
        state: Comment.Saving({ draft }),
      };
    }

    case "failed": {
      return {
        effect: { kind: "none" },
        state: Comment.Failed({
          draft: commentDraft(state),
          message: event.message,
        }),
      };
    }

    case "cancel":
    case "deleteCancel": {
      return { effect: { kind: "none" }, state: Comment.Read() };
    }

    case "deleteRequest": {
      return { effect: { kind: "none" }, state: Comment.DeleteConfirm() };
    }

    case "deleteConfirm": {
      return state._tag === "DeleteConfirm"
        ? { effect: { kind: "delete" }, state: Comment.Deleting() }
        : { effect: { kind: "none" }, state };
    }

    default: {
      return { effect: { kind: "none" }, state };
    }
  }
};
