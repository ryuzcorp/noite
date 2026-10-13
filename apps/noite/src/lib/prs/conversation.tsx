/** Pull-request Conversation tab: the description, the merged comment/review
 * timeline (outdated comments carry their file/line) and the comment box. */
import { atom } from "ilha";

import { errorMessage } from "../errors";
import type { AppRole } from "../roles";
import type { PrDetail } from "../runner";
import { prsUpdate } from "../server/prs.server";
import { buildTimeline } from "./data";
import { invalidatePr } from "./resources";
import { CommentCard, CommentComposer, nameFor, ReviewCard } from "./widgets";

const PrDescription = ({
  appId,
  detail,
  canEdit,
  names,
}: {
  appId: string;
  detail: PrDetail;
  canEdit: boolean;
  names: Record<string, string> | undefined;
}) => {
  const editing = atom(false);
  const title = atom(detail.pullRequest.title);
  const body = atom(detail.pullRequest.body);
  const busy = atom(false);
  const notice = atom("");
  const { pullRequest } = detail;

  const save = async (): Promise<void> => {
    const nextTitle = title().trim();
    if (nextTitle === "" || busy()) {
      return;
    }
    busy.set(true);
    notice.set("");
    try {
      await prsUpdate({
        appId,
        body: body(),
        number: pullRequest.number,
        title: nextTitle,
      });
      editing.set(false);
      invalidatePr(appId, pullRequest.number);
    } catch (error) {
      notice.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  if (editing()) {
    return (
      <form
        class="border-base-300 flex flex-col gap-3 rounded-lg border p-3"
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          class="input w-full"
          aria-label="Pull title"
          value={title()}
          oninput={(event) => {
            title.set(event.currentTarget.value);
          }}
        />
        <textarea
          class="textarea w-full"
          rows={6}
          aria-label="Pull description"
          value={body()}
          oninput={(event) => {
            body.set(event.currentTarget.value);
          }}
        />
        {notice() ? (
          <p class="text-error m-0 text-sm" role="alert">
            {notice()}
          </p>
        ) : null}
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onclick={() => {
              editing.set(false);
              title.set(pullRequest.title);
              body.set(pullRequest.body);
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn btn-sm btn-neutral"
            disabled={busy() || title().trim() === ""}
          >
            Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <div class="border-base-300 flex flex-col gap-2 rounded-lg border p-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-sm font-medium">
          {nameFor(names, pullRequest.authorId)} opened this pull
        </span>
        {canEdit ? (
          <button
            type="button"
            class="link link-hover text-xs"
            onclick={() => {
              editing.set(true);
            }}
          >
            Edit
          </button>
        ) : null}
      </div>
      {pullRequest.body === "" ? (
        <p class="m-0 text-sm opacity-70">No description provided.</p>
      ) : (
        <p class="m-0 text-sm break-words whitespace-pre-wrap">
          {pullRequest.body}
        </p>
      )}
    </div>
  );
};

export const PrConversationTab = ({
  appId,
  detail,
  names,
  role,
  viewerId,
}: {
  appId: string;
  detail: PrDetail;
  names: Record<string, string> | undefined;
  role: AppRole | undefined;
  viewerId: string;
}) => {
  const { pullRequest } = detail;
  const canEdit =
    role === "admin" || (viewerId !== "" && pullRequest.authorId === viewerId);
  const timeline = buildTimeline(detail.comments, detail.reviews);
  return (
    <div class="flex flex-col gap-4">
      <PrDescription
        appId={appId}
        canEdit={canEdit}
        detail={detail}
        names={names}
      />
      {timeline.map((entry) =>
        entry.kind === "comment" ? (
          <CommentCard
            key={entry.id}
            appId={appId}
            comment={entry.comment}
            names={names}
            number={pullRequest.number}
            role={role}
            viewerId={viewerId}
          />
        ) : (
          <ReviewCard key={entry.id} names={names} review={entry.review} />
        )
      )}
      <CommentComposer appId={appId} number={pullRequest.number} />
    </div>
  );
};
