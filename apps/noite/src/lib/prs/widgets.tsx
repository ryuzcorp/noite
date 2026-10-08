/** Shared pull-request widgets: state badges, name resolution and the
 * comment/review cards the Conversation and Files tabs both render. */
import { atom } from "ilha";

import { formatAgo } from "../dates";
import { errorMessage } from "../errors";
import type { AppRole } from "../roles";
import type { PrComment, PrReview } from "../runner";
import {
  prsComment,
  prsCommentDelete,
  prsCommentEdit,
} from "../server/prs.server";
import { Avatar } from "../ui/avatar";
import { lineAnchor } from "./data";
import type { DiffSide, LineAnchor } from "./data";
import { invalidatePr } from "./resources";

const PR_STATES = [
  { badge: "badge-success", id: "open", label: "Open" },
  { badge: "badge-ghost", id: "closed", label: "Closed" },
  { badge: "badge-info", id: "merged", label: "Merged" },
] as const;

const REVIEW_STATES = [
  { badge: "badge-success", id: "approved", label: "Approved" },
  { badge: "badge-error", id: "changes_requested", label: "Changes requested" },
] as const;

/** A user id's display name, or "Former user" when the account is gone. */
export const nameFor = (
  names: Record<string, string> | undefined,
  id: string
): string => names?.[id] ?? "Former user";

export const PrStateBadge = ({ state }: { state: string }) => {
  const info = PR_STATES.find((entry) => entry.id === state);
  return (
    <span class={`badge badge-sm ${info?.badge ?? "badge-ghost"}`}>
      {info?.label ?? state}
    </span>
  );
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
  const draft = atom("");
  const busy = atom(false);
  const notice = atom("");

  const submit = async (): Promise<void> => {
    const body = draft().trim();
    if (body === "" || busy()) {
      return;
    }
    busy.set(true);
    notice.set("");
    try {
      await (anchor
        ? prsComment({
            appId,
            body,
            commitSha: anchor.commitSha,
            line: anchor.line,
            number,
            path: anchor.path,
            side: anchor.side,
          })
        : prsComment({ appId, body, number }));
      draft.set("");
      invalidatePr(appId, number);
      onPosted?.();
    } catch (error) {
      notice.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <form
      class="flex flex-col gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        class="textarea w-full"
        rows={3}
        aria-label={anchor ? `Comment on ${anchorLabel(anchor)}` : placeholder}
        placeholder={placeholder}
        value={draft()}
        oninput={(event) => {
          draft.set(event.currentTarget.value);
        }}
      />
      {notice() ? (
        <p class="text-error m-0 text-sm" role="alert">
          {notice()}
        </p>
      ) : null}
      <div class="flex justify-end">
        <button
          type="submit"
          class="btn btn-sm btn-neutral"
          disabled={busy() || draft().trim() === ""}
        >
          {busy() ? "Posting…" : submitLabel}
        </button>
      </div>
    </form>
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
  const editing = atom(false);
  const draft = atom(comment.body);
  const busy = atom(false);
  const notice = atom("");
  const mine = viewerId !== "" && comment.authorId === viewerId;
  const canEdit = mine && role !== undefined;
  const canDelete = (mine || role === "admin") && role !== undefined;
  const anchor = showAnchor ? lineAnchor(comment) : null;

  const run = async (work: () => Promise<void>): Promise<void> => {
    busy.set(true);
    notice.set("");
    try {
      await work();
      invalidatePr(appId, number);
    } catch (error) {
      notice.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

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
        {editing() ? (
          <form
            class="flex flex-col gap-2"
            onsubmit={(event) => {
              event.preventDefault();
              const body = draft().trim();
              if (body === "") {
                return;
              }
              void run(async () => {
                await prsCommentEdit({ appId, body, commentId: comment.id });
                editing.set(false);
              });
            }}
          >
            <textarea
              class="textarea w-full"
              rows={3}
              aria-label="Edit comment"
              value={draft()}
              oninput={(event) => {
                draft.set(event.currentTarget.value);
              }}
            />
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick={() => {
                  editing.set(false);
                  draft.set(comment.body);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-sm btn-neutral"
                disabled={busy() || draft().trim() === ""}
              >
                Save
              </button>
            </div>
          </form>
        ) : (
          <p class="m-0 text-sm break-words whitespace-pre-wrap">
            {comment.body}
          </p>
        )}
        {notice() ? (
          <p class="text-error m-0 text-sm" role="alert">
            {notice()}
          </p>
        ) : null}
        {editing() || (!canEdit && !canDelete) ? null : (
          <div class="flex gap-2 text-xs">
            {canEdit ? (
              <button
                type="button"
                class="link link-hover"
                onclick={() => {
                  editing.set(true);
                }}
              >
                Edit
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                class="link link-hover text-error"
                disabled={busy()}
                onclick={() => {
                  // oxlint-disable-next-line no-alert -- native confirm is the destructive-action guard used elsewhere.
                  if (!confirm("Delete this comment?")) {
                    return;
                  }
                  void run(async () => {
                    await prsCommentDelete({ appId, commentId: comment.id });
                  });
                }}
              >
                Delete
              </button>
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
  const info = REVIEW_STATES.find((entry) => entry.id === review.state);
  return (
    <article class="border-base-300 flex items-center gap-3 rounded-lg border p-3">
      <Avatar label={nameFor(names, review.reviewerId)} size="sm" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span class="font-medium">{nameFor(names, review.reviewerId)}</span>
          <span class={`badge badge-sm ${info?.badge ?? "badge-ghost"}`}>
            {info?.label ?? review.state}
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
