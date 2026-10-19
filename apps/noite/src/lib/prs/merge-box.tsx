/** Pull-request merge controls. The header carries the merge state (with the
 * approval count) and the Close/Reopen and Merge actions — Merge opens the
 * squash form in a dropdown, like the app header's Deploy. The side box keeps
 * what a reviewer reads and does: the closed/merged note, conflicts and the
 * review buttons. */
import { atom, watch } from "ilha";

import { api } from "../api";
import type { PrMergeInput } from "../api-types";
import { errorMessage } from "../errors";
import { collectRef, liveEl, newLiveRef } from "../live-ref";
import { environments } from "../resources";
import type { AppRole } from "../roles";
import type { PrDetail } from "../runner";
import { latestReviews } from "./data";
import { invalidatePr } from "./resources";

const MERGE_STATES = [
  { badge: "badge-success", id: "mergeable", label: "Ready to merge" },
  { badge: "badge-error", id: "conflicts", label: "Merge conflicts" },
  {
    badge: "badge-warning",
    id: "blocked_approvals",
    label: "Waiting for approvals",
  },
  { badge: "badge-ghost", id: "closed", label: "Closed" },
  { badge: "badge-info", id: "merged", label: "Merged" },
  { badge: "badge-error", id: "head_missing", label: "Head branch is gone" },
] as const;

/** A mutation's busy flag and error, and the runner that refetches the pull
 * once it lands. Each control group has its own, so an error shows where its
 * action was taken. */
const prAction = (appId: string, number: number) => {
  const busy = atom(false);
  const notice = atom("");

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

  return { busy, notice, run };
};

/** The merge state for the header: the approval count when approvals gate the
 * merge (never a bare "0/0"), then what it means. */
export const PrMergeState = ({ detail }: { detail: PrDetail }) => {
  const info = MERGE_STATES.find((entry) => entry.id === detail.mergeState);

  const gated =
    detail.mergeState === "mergeable" ||
    detail.mergeState === "blocked_approvals";

  const approvals =
    gated && detail.requiredApprovals > 0
      ? `${detail.approvals} of ${detail.requiredApprovals} approvals`
      : null;

  const label = info?.label ?? detail.mergeState;

  return (
    <span
      class={`badge badge-sm ${info?.badge ?? "badge-ghost"}`}
      title={`${detail.approvals} of ${detail.requiredApprovals} required approvals`}
    >
      {approvals === null ? label : `${approvals} · ${label}`}
    </span>
  );
};

/** The squash form, inside the Merge dropdown. The trigger is a real button
 * (Escape closes it and returns focus); deleting the head branch also tears
 * down its preview environment, which the checkbox says. */
const MergeDropdown = ({
  appId,
  detail,
}: {
  appId: string;
  detail: PrDetail;
}) => {
  const { pullRequest } = detail;
  const { busy, notice, run } = prAction(appId, pullRequest.number);
  const title = atom(pullRequest.title);
  const message = atom("");
  const deleteBranch = atom(false);
  const open = atom(false);
  const box = atom.lazy(() => newLiveRef<HTMLElement>())();
  const trigger = atom.lazy(() => newLiveRef<HTMLButtonElement>())();
  const canMerge = detail.mergeState === "mergeable";

  const reason = MERGE_STATES.find(
    (entry) => entry.id === detail.mergeState
  )?.label;

  // The head branch's own environment, when it has one: deleting the branch
  // deletes the environment and everything it stored.
  const environment = (environments(appId).data() ?? []).find(
    (row) => row.gitRef === `refs/heads/${pullRequest.head}`
  );

  const close = (): void => {
    open.set(false);
    liveEl(trigger)?.focus();
  };

  // Clicking outside the form closes it, the way the branch picker's dropdown
  // does (its own focus handling is native).
  const onPointerDown = (event: PointerEvent): void => {
    const el = liveEl(box);

    if (el !== null && !event.composedPath().includes(el)) {
      open.set(false);
    }
  };

  watch(open, (isOpen, { onCleanup }) => {
    if (!isOpen) {
      return;
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    });
  });

  return (
    <div
      class="relative"
      ref={(el) => {
        collectRef(box, el);
      }}
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === "Escape" && open()) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={(el) => {
          collectRef(trigger, el);
        }}
        class="btn btn-sm btn-neutral"
        aria-expanded={open() ? "true" : "false"}
        aria-haspopup="true"
        onclick={() => {
          open.set(!open());
        }}
      >
        Merge
      </button>
      {open() ? (
        <div class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box absolute right-0 z-10 mt-1 w-80 border p-4 shadow-md">
          <div class="flex flex-col gap-2">
            <fieldset class="fieldset">
              <label class="label text-xs" for="squash-title">
                Squash commit title
              </label>
              <input
                id="squash-title"
                class="input input-sm w-full"
                value={title()}
                oninput={(event) => {
                  title.set(event.currentTarget.value);
                }}
              />
            </fieldset>
            <fieldset class="fieldset">
              <label class="label text-xs" for="squash-message">
                Extended description
              </label>
              <textarea
                id="squash-message"
                class="textarea w-full"
                rows={3}
                placeholder="Optional"
                value={message()}
                oninput={(event) => {
                  message.set(event.currentTarget.value);
                }}
              />
            </fieldset>
            <label class="flex w-fit items-start gap-2 text-sm">
              <input
                type="checkbox"
                class="checkbox checkbox-sm"
                checked={deleteBranch()}
                onchange={(event) => {
                  deleteBranch.set(event.currentTarget.checked);
                }}
              />
              <span>
                Delete <span class="font-mono">{pullRequest.head}</span> after
                merging
                {environment === undefined ? null : (
                  <>
                    {" — also deletes the "}
                    <span class="font-mono">{environment.label}</span>
                    {" environment and its data"}
                  </>
                )}
              </span>
            </label>
            {canMerge ? null : (
              <p class="m-0 text-xs opacity-70">
                {reason ?? "This pull request cannot merge"}.
              </p>
            )}
            {notice() ? (
              <p class="text-error m-0 text-sm" role="alert">
                {notice()}
              </p>
            ) : null}
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={!canMerge || busy()}
              onclick={() => {
                void run(async () => {
                  const args: PrMergeInput = {
                    appId,
                    deleteBranch: deleteBranch(),
                    number: pullRequest.number,
                  };

                  const squashTitle = title().trim();

                  if (squashTitle !== "") {
                    args.title = squashTitle;
                  }

                  const squashMessage = message().trim();

                  if (squashMessage !== "") {
                    args.message = squashMessage;
                  }

                  await api<{ ok: true }>("/api/prs/prsMerge", args);
                  open.set(false);
                });
              }}
            >
              {busy() ? "Merging…" : "Squash and merge"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** The header's actions: Close/Reopen (the author or an admin) and Merge
 * (an open pull, for `push`). */
export const PrHeaderActions = ({
  appId,
  detail,
  role,
  viewerId,
}: {
  appId: string;
  detail: PrDetail;
  role: AppRole | undefined;
  viewerId: string;
}) => {
  const { pullRequest } = detail;
  const { busy, notice, run } = prAction(appId, pullRequest.number);
  const isAuthor = viewerId !== "" && pullRequest.authorId === viewerId;
  const canPush = role === "push" || role === "admin";

  const canClose =
    canPush && (isAuthor || role === "admin") && pullRequest.state !== "merged";

  const canMerge = canPush && pullRequest.state === "open";

  if (!(canClose || canMerge)) {
    return null;
  }

  return (
    <div class="flex shrink-0 flex-col items-end gap-1">
      <div class="flex items-center gap-2">
        {canClose ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={busy()}
            onclick={() => {
              void run(async () => {
                await api<{ ok: true }>("/api/prs/prsUpdate", {
                  appId,
                  number: pullRequest.number,
                  state: pullRequest.state === "open" ? "closed" : "open",
                });
              });
            }}
          >
            {pullRequest.state === "open" ? "Close" : "Reopen"}
          </button>
        ) : null}
        {canMerge ? <MergeDropdown appId={appId} detail={detail} /> : null}
      </div>
      {notice() ? (
        <p class="text-error m-0 text-xs" role="alert">
          {notice()}
        </p>
      ) : null}
    </div>
  );
};

/** How the pull ended: the merge sha, or that its head branch is gone. */
const EndedNotice = ({ detail }: { detail: PrDetail }) => {
  const { pullRequest } = detail;
  let message = "This pull request is closed.";

  if (pullRequest.mergeSha !== null) {
    message = `Merged as ${pullRequest.mergeSha}.`;
  }

  const deleted = pullRequest.mergeSha !== null && detail.compare === null;

  return (
    <p class="m-0 text-xs opacity-70">
      {message}
      {deleted ? " The head branch was deleted." : null}
    </p>
  );
};

/** The files blocking the merge. */
const ConflictList = ({ conflicts }: { conflicts: readonly string[] }) => (
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium">Conflicts</span>
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      {conflicts.map((path) => (
        <li key={path} class="font-mono text-xs">
          {path}
        </li>
      ))}
    </ul>
  </div>
);

/** The reviewer's own dismissed-or-not notices and the two review buttons. */
const ReviewSection = ({
  approved,
  approvedStill,
  busy,
  onReview,
  requested,
  requestedStill,
}: {
  approved: boolean;
  approvedStill: boolean;
  busy: () => boolean;
  onReview: (state: "approved" | "changes_requested") => void;
  requested: boolean;
  requestedStill: boolean;
}) => (
  <div class="flex flex-col gap-2">
    {approvedStill ? (
      <p class="m-0 text-xs opacity-70">You approved this pull request.</p>
    ) : null}
    {requestedStill ? (
      <p class="m-0 text-xs opacity-70">
        You requested changes on this pull request.
      </p>
    ) : null}
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="btn btn-sm btn-success"
        disabled={busy() || approvedStill}
        onclick={() => {
          onReview("approved");
        }}
      >
        {approved ? "Approve again" : "Approve"}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-error btn-outline"
        disabled={busy() || requestedStill}
        onclick={() => {
          onReview("changes_requested");
        }}
      >
        {requested ? "Change review" : "Request changes"}
      </button>
    </div>
  </div>
);

/** The side box: how the pull ended (when it has), its conflicts, and the
 * review buttons for anyone but the author. Nothing to show — no box. */
export const PrReviewBox = ({
  appId,
  detail,
  role,
  viewerId,
}: {
  appId: string;
  detail: PrDetail;
  role: AppRole | undefined;
  viewerId: string;
}) => {
  const { pullRequest } = detail;
  const { busy, notice, run } = prAction(appId, pullRequest.number);
  const isAuthor = viewerId !== "" && pullRequest.authorId === viewerId;

  const canReview =
    (role === "push" || role === "admin") &&
    !isAuthor &&
    pullRequest.state === "open";

  const conflicts = detail.compare?.conflicts ?? [];
  const ended = pullRequest.state !== "open";
  const latest = latestReviews(detail.reviews);
  const myLatest = latest.find((review) => review.reviewerId === viewerId);
  // A review at a superseded head is dismissed but still yours: the button
  // offers the action again rather than stacking an identical review.
  const approved = myLatest?.state === "approved";
  const requested = myLatest?.state === "changes_requested";
  const approvedStill = approved && !myLatest?.dismissedAt;
  const requestedStill = requested && !myLatest?.dismissedAt;

  if (!(canReview || conflicts.length > 0 || ended)) {
    return null;
  }

  const review = (state: "approved" | "changes_requested") => {
    void run(async () => {
      await api<{ ok: true }>("/api/prs/prsReview", {
        appId,
        number: pullRequest.number,
        state,
      });
    });
  };

  return (
    <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-3">
      {ended ? <EndedNotice detail={detail} /> : null}
      {conflicts.length > 0 ? <ConflictList conflicts={conflicts} /> : null}
      {canReview ? (
        <ReviewSection
          approved={approved}
          approvedStill={approvedStill}
          busy={busy}
          onReview={review}
          requested={requested}
          requestedStill={requestedStill}
        />
      ) : null}
      {notice() ? (
        <p class="text-error m-0 text-sm" role="alert">
          {notice()}
        </p>
      ) : null}
    </section>
  );
};
