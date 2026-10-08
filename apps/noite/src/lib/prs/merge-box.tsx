/** Pull-request merge box: merge state, approvals, conflicts, the squash
 * inputs, review buttons and merge/close/reopen. */
import { atom } from "ilha";

import { errorMessage } from "../errors";
import type { AppRole } from "../roles";
import type { PrDetail } from "../runner";
import { prsMerge, prsReview, prsUpdate } from "../server/prs.server";
import type { PrMergeInput } from "../server/prs.server";
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

/** Runs a mutation, then refetches the detail; shared by the sub-forms. */
type PrRun = (work: () => Promise<void>) => Promise<void>;

const Conflicts = ({ paths }: { paths: string[] }) => {
  if (paths.length === 0) {
    return null;
  }
  return (
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium">Conflicts</span>
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        {paths.map((path) => (
          <li key={path} class="font-mono text-xs">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
};

const ReviewActions = ({
  appId,
  busy,
  detail,
  role,
  run,
  viewerId,
}: {
  appId: string;
  busy: boolean;
  detail: PrDetail;
  role: AppRole | undefined;
  run: PrRun;
  viewerId: string;
}) => {
  const { pullRequest } = detail;
  const isAuthor = viewerId !== "" && pullRequest.authorId === viewerId;
  const canPush = role === "push" || role === "admin";
  const canClose =
    (isAuthor || role === "admin") && pullRequest.state !== "merged";
  if (!canPush) {
    return null;
  }
  return (
    <div class="flex flex-wrap items-center gap-2">
      {isAuthor ? null : (
        <>
          <button
            type="button"
            class="btn btn-sm btn-success"
            disabled={busy}
            onclick={() => {
              void run(async () => {
                await prsReview({
                  appId,
                  number: pullRequest.number,
                  state: "approved",
                });
              });
            }}
          >
            Approve
          </button>
          <button
            type="button"
            class="btn btn-sm btn-error btn-outline"
            disabled={busy}
            onclick={() => {
              void run(async () => {
                await prsReview({
                  appId,
                  number: pullRequest.number,
                  state: "changes_requested",
                });
              });
            }}
          >
            Request changes
          </button>
        </>
      )}
      {canClose ? (
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          disabled={busy}
          onclick={() => {
            void run(async () => {
              await prsUpdate({
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
    </div>
  );
};

const SquashForm = ({
  appId,
  busy,
  detail,
  run,
}: {
  appId: string;
  busy: boolean;
  detail: PrDetail;
  run: PrRun;
}) => {
  const { pullRequest } = detail;
  const title = atom(pullRequest.title);
  const message = atom("");
  const deleteBranch = atom(true);
  const canMerge = detail.mergeState === "mergeable";
  if (pullRequest.state !== "open") {
    return null;
  }
  return (
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
      <label class="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          checked={deleteBranch()}
          onchange={(event) => {
            deleteBranch.set(event.currentTarget.checked);
          }}
        />
        Delete the head branch after merging
      </label>
      <button
        type="button"
        class="btn btn-sm btn-neutral"
        disabled={!canMerge || busy}
        title={canMerge ? "Squash and merge" : "This pull cannot merge"}
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
            await prsMerge(args);
          });
        }}
      >
        Merge pull
      </button>
    </div>
  );
};

export const PrMergeBox = ({
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
  const busy = atom(false);
  const notice = atom("");
  const info = MERGE_STATES.find((entry) => entry.id === detail.mergeState);

  const run: PrRun = async (work) => {
    busy.set(true);
    notice.set("");
    try {
      await work();
      invalidatePr(appId, pullRequest.number);
    } catch (error) {
      notice.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-3">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="m-0 text-sm font-semibold">Merge</h2>
        <span class={`badge badge-sm ${info?.badge ?? "badge-ghost"}`}>
          {info?.label ?? detail.mergeState}
        </span>
        <span class="text-base-content/70 text-xs tabular-nums">
          {detail.approvals} of {detail.requiredApprovals} approvals
        </span>
      </div>

      {pullRequest.state === "open" ? null : (
        <p class="m-0 text-xs opacity-70">
          {pullRequest.mergeSha === null
            ? "This pull is closed."
            : `Merged as ${pullRequest.mergeSha}.`}
        </p>
      )}

      <Conflicts paths={detail.compare?.conflicts ?? []} />
      <ReviewActions
        appId={appId}
        busy={busy()}
        detail={detail}
        role={role}
        run={run}
        viewerId={viewerId}
      />
      <SquashForm appId={appId} busy={busy()} detail={detail} run={run} />

      {notice() ? (
        <p class="text-error m-0 text-sm" role="alert">
          {notice()}
        </p>
      ) : null}
    </section>
  );
};
