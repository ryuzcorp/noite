/** Shared pull-request widgets: state badges, name resolution and the
 * comment/review cards the Conversation and Files tabs both render. */
import { atom } from "ilha";

import { api } from "../api";
import { formatAgo } from "../dates";
import { errorMessage } from "../errors";
import type { AppRole } from "../roles";
import type { PrComment, PrReview } from "../runner";
import { Avatar } from "../ui/avatar";
import { Comment, commentDraft, commentEditing, nextComment } from "./composer";
import type { CommentEvent, CommentState } from "./composer";
import { lineAnchor } from "./data";
import type { DiffSide, LineAnchor } from "./data";
import { invalidatePr } from "./resources";
import { prStateFacts, reviewStateFacts, toPrState } from "./status";

/** A user id's display name, or "Former user" when the account is gone. */
export const nameFor = (
  names: Record<string, string> | undefined,
  id: string
): string => names?.[id] ?? "Former user";

export const PrStateBadge = ({ state }: { state: string }) => {
  const facts = prStateFacts(toPrState(state));

  return <span class={`badge badge-sm ${facts.badge}`}>{facts.label}</span>;
};

/** A diff anchor a composer attaches its comment to. */
export interface ComposerAnchor extends LineAnchor {
  commitSha: string;
}

const anchorLabel = (anchor: LineAnchor): string =>
  `${anchor.path}:${anchor.line} · ${anchor.side === "old" ? "before" : "after"}`;

/** Conversation and line-thread composer. With an `anchor` the comment is a
 * line comment (the runner needs path, line, side and commitSha). */
export const CommentComposer = ({
  appId,
  number,
  anchor,
  onPosted,
  placeholder = "Leave a comment",
  submitLabel = "Comment",
}: {
  appId: string;
  number: number;
  anchor?: ComposerAnchor;
  onPosted?: () => void;
  placeholder?: string;
  submitLabel?: string;
}) => {
  const state = atom<CommentState>(Comment.Editing({ draft: "" }));
  const current = state();
  const busy = current._tag === "Saving";
  const notice = current._tag === "Failed" ? current.message : "";

  const post = async (body: string): Promise<void> => {
    try {
      await (anchor
        ? api<{ ok: true }>("/api/prs/prsComment", {
            appId,
            body,
            commitSha: anchor.commitSha,
            line: anchor.line,
            number,
            path: anchor.path,
            side: anchor.side,
          })
        : api<{ ok: true }>("/api/prs/prsComment", { appId, body, number }));
      state.set(nextComment(state(), { kind: "saved" }).state);
      state.set(Comment.Editing({ draft: "" }));
      invalidatePr(appId, number);
      onPosted?.();
    } catch (error) {
      state.set(
        nextComment(state(), {
          kind: "failed",
          message: errorMessage(error),
        }).state
      );
    }
  };

  /** The one dispatcher: state changes and the effects they return. */
  const apply = (event: CommentEvent) => {
    const step = nextComment(state(), event);
    state.set(step.state);

    if (step.effect.kind === "save") {
      void post(step.effect.body);
    }
  };

  return (
    <form
      class="flex flex-col gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        apply({ kind: "submit" });
      }}
    >
      <textarea
        class="textarea w-full"
        rows={3}
        aria-label={anchor ? `Comment on ${anchorLabel(anchor)}` : placeholder}
        placeholder={placeholder}
        disabled={busy}
        value={commentDraft(state())}
        oninput={(event) => {
          apply({ draft: event.currentTarget.value, kind: "change" });
        }}
      />
      {notice === "" ? null : (
        <p class="text-error m-0 text-sm" role="alert">
          {notice}
        </p>
      )}
      <div class="flex justify-end">
        <button
          type="submit"
          class="btn btn-sm btn-neutral"
          disabled={busy || commentDraft(state()).trim() === ""}
        >
          {busy ? "Posting…" : submitLabel}
        </button>
      </div>
    </form>
  );
};

/** The inline edit form: controlled by the composer machine's state. */
const CommentEditForm = ({
  busy,
  draft,
  onCancel,
  onChange,
  onSubmit,
}: {
  busy: boolean;
  draft: string;
  onCancel: () => void;
  onChange: (draft: string) => void;
  onSubmit: () => void;
}) => (
  <form
    class="flex flex-col gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <textarea
      class="textarea w-full"
      rows={3}
      aria-label="Edit comment"
      disabled={busy}
      value={draft}
      oninput={(event) => {
        onChange(event.currentTarget.value);
      }}
    />
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        disabled={busy}
        onclick={onCancel}
      >
        Cancel
      </button>
      <button
        type="submit"
        class="btn btn-sm btn-neutral"
        disabled={busy || draft.trim() === ""}
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  </form>
);

/** The comment's delete control: one click arms an inline confirmation (a
 * state of the composer machine, not an awaited browser dialog). */
const DeleteCommentControl = ({
  armed,
  busy,
  onCancel,
  onConfirm,
  onRequest,
}: {
  armed: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRequest: () => void;
}) => {
  if (armed) {
    return (
      <span class="flex items-center gap-2">
        <span class="text-error">Delete this comment?</span>
        <button
          type="button"
          class="link link-hover text-error"
          onclick={onConfirm}
        >
          Delete
        </button>
        <button type="button" class="link link-hover" onclick={onCancel}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      class="link link-hover text-error"
      disabled={busy}
      onclick={onRequest}
    >
      Delete
    </button>
  );
};

/** One comment: author, time, optional anchor/outdated markers, and
 * edit/delete for its author (delete also for admins). */
export const CommentCard = ({
  appId,
  number,
  comment,
  names,
  role,
  showAnchor = true,
  viewerId,
}: {
  appId: string;
  number: number;
  comment: PrComment;
  names: Record<string, string> | undefined;
  role: AppRole | undefined;
  showAnchor?: boolean;
  viewerId: string;
}) => {
  const state = atom<CommentState>(Comment.Read());
  const current = state();
  const busy = current._tag === "Saving" || current._tag === "Deleting";
  const notice = current._tag === "Failed" ? current.message : "";

  const editing = commentEditing(current);

  const mine = viewerId !== "" && comment.authorId === viewerId;
  const canEdit = mine && role !== undefined;
  const canDelete = (mine || role === "admin") && role !== undefined;
  const anchor = showAnchor ? lineAnchor(comment) : null;

  const fail = (message: string) => {
    state.set(nextComment(state(), { kind: "failed", message }).state);
  };

  const finish = (event: CommentEvent) => {
    state.set(nextComment(state(), event).state);
  };

  const save = async (body: string): Promise<void> => {
    try {
      await api<{ ok: true }>("/api/prs/prsCommentEdit", {
        appId,
        body,
        commentId: comment.id,
      });
      invalidatePr(appId, number);
      finish({ kind: "saved" });
    } catch (error) {
      fail(errorMessage(error));
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await api<{ ok: true }>("/api/prs/prsCommentDelete", {
        appId,
        commentId: comment.id,
      });
      invalidatePr(appId, number);
      finish({ kind: "deleted" });
    } catch (error) {
      fail(errorMessage(error));
    }
  };

  /** The one dispatcher: the machine's effect is the only side effect. */
  const apply = (event: CommentEvent) => {
    const step = nextComment(state(), event);
    state.set(step.state);

    if (step.effect.kind === "save") {
      void save(step.effect.body);
    }

    if (step.effect.kind === "delete") {
      void remove();
    }
  };

  if (current._tag === "Gone") {
    return null;
  }

  return (
    <article class="border-base-300 flex gap-3 rounded-lg border p-3">
      <Avatar label={nameFor(names, comment.authorId)} size="sm" />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span class="font-medium">{nameFor(names, comment.authorId)}</span>
          <span class="text-base-content/70 text-xs">
            {formatAgo(comment.createdAt)}
          </span>
          {comment.editedAt ? (
            <span class="text-base-content/60 text-xs">edited</span>
          ) : null}
          {comment.outdated ? (
            <span class="badge badge-sm badge-warning">Outdated</span>
          ) : null}
          {anchor ? (
            <span class="text-base-content/70 font-mono text-xs">
              {anchorLabel(anchor)}
            </span>
          ) : null}
        </div>
        {editing ? (
          <CommentEditForm
            busy={busy}
            draft={commentDraft(current)}
            onChange={(draft) => {
              apply({ draft, kind: "change" });
            }}
            onCancel={() => {
              apply({ kind: "cancel" });
            }}
            onSubmit={() => {
              apply({ kind: "submit" });
            }}
          />
        ) : (
          <p class="m-0 text-sm break-words whitespace-pre-wrap">
            {comment.body}
          </p>
        )}
        {notice === "" ? null : (
          <p class="text-error m-0 text-sm" role="alert">
            {notice}
          </p>
        )}
        {editing || (!canEdit && !canDelete) ? null : (
          <div class="flex gap-2 text-xs">
            {canEdit ? (
              <button
                type="button"
                class="link link-hover"
                onclick={() => {
                  apply({ kind: "edit", original: comment.body });
                }}
              >
                Edit
              </button>
            ) : null}
            {canDelete ? (
              <DeleteCommentControl
                armed={current._tag === "DeleteConfirm"}
                busy={busy}
                onCancel={() => {
                  apply({ kind: "deleteCancel" });
                }}
                onConfirm={() => {
                  apply({ kind: "deleteConfirm" });
                }}
                onRequest={() => {
                  apply({ kind: "deleteRequest" });
                }}
              />
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
};

/** One review event in the timeline. */
export const ReviewCard = ({
  names,
  review,
}: {
  names: Record<string, string> | undefined;
  review: PrReview;
}) => {
  const facts = reviewStateFacts(review.state);

  return (
    <article class="border-base-300 flex items-center gap-3 rounded-lg border p-3">
      <Avatar label={nameFor(names, review.reviewerId)} size="sm" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span class="font-medium">{nameFor(names, review.reviewerId)}</span>
          <span class={`badge badge-sm ${facts?.badge ?? "badge-ghost"}`}>
            {facts?.label ?? review.state}
          </span>
          {review.dismissedAt ? (
            <span class="badge badge-sm badge-ghost">Dismissed</span>
          ) : null}
          <span class="text-base-content/70 text-xs">
            {formatAgo(review.createdAt)}
          </span>
        </div>
      </div>
    </article>
  );
};

/** Side label used by the Files tab's line pickers. */
export const SIDE_LABEL: Record<DiffSide, string> = {
  new: "After",
  old: "Before",
};
