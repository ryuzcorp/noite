/** Pull-request merge controls. The header carries the merge state (with the
 * approval count) and the Close/Reopen and Merge actions — Merge opens the
 * squash form in a dropdown, like the app header's Deploy. The side box keeps
 * what a reviewer reads and does: the closed/merged note, conflicts and the
 * review buttons.
 *
 * Every enabled/disabled decision comes from `prCapabilities` (./status) and
 * every write from the one `PrMutation` value (./mutation) the detail body
 * owns, so Close, Merge and a review cannot run at once and a button is never
 * offered for a transition the runner refuses. */
import type { AtomHandle } from "ilha";
import { atom, watch } from "ilha";

import { api } from "../api";
import type { PrMergeInput } from "../api-types";
import { errorMessage } from "../errors";
import { collectRef, liveEl, newLiveRef } from "../live-ref";
import { resourceValue } from "../resource";
import { environments } from "../resources";
import type { AppRole } from "../roles";
import type { PrDetail } from "../runner";
import { mutationProblem, mutationRunning, nextMutation } from "./mutation";
import type { PrMutation, PrMutationKind } from "./mutation";
import { invalidatePr } from "./resources";
import type { MyVerdict } from "./status";
import {
  mergeStateFacts,
  myVerdict,
  prCapabilities,
  switchStateAction,
} from "./status";

/** Run one PR mutation through the shared machine: refused while another is
 * in flight, refetches the pull once it lands, and reports the outcome. */
const runMutation = async (
  mutation: AtomHandle<PrMutation>,
  kind: PrMutationKind,
  appId: string,
  number: number,
  work: () => Promise<void>
): Promise<boolean> => {
  if (mutationRunning(mutation())) {
    return false;
  }

  mutation.set(nextMutation(mutation(), { kind: "start", mutation: kind }));

  try {
    await work();
    invalidatePr(appId, number);
    mutation.set(nextMutation(mutation(), { kind: "done" }));

    return true;
  } catch (error) {
    mutation.set(
      nextMutation(mutation(), { kind: "failed", message: errorMessage(error) })
    );

    return false;
  }
};

/** The merge state for the header: the approval count when approvals gate the
 * merge (never a bare "0/0"), then what it means. */
export const PrMergeState = ({ detail }: { detail: PrDetail }) => {
  const facts = mergeStateFacts(detail.mergeState);

  const approvals =
    facts.gated && detail.requiredApprovals > 0
      ? `${detail.approvals} of ${detail.requiredApprovals} approvals`
      : null;

  return (
    <span
      class={`badge badge-sm ${facts.badge}`}
      title={`${detail.approvals} of ${detail.requiredApprovals} required approvals`}
    >
      {approvals === null ? facts.label : `${approvals} · ${facts.label}`}
    </span>
  );
};

/** The squash form, inside the Merge dropdown. The trigger is a real button
 * (Escape closes it and returns focus); deleting the head branch also tears
 * down its preview environment, which the checkbox says. */
const MergeDropdown = ({
  appId,
  canMerge,
  detail,
  mutation,
}: {
  appId: string;
  canMerge: boolean;
  detail: PrDetail;
  mutation: AtomHandle<PrMutation>;
}) => {
  const { pullRequest } = detail;
  const notice = mutationProblem(mutation(), ["merge"]);
  const busy = mutationRunning(mutation());
  const title = atom(pullRequest.title);
  const message = atom("");
  const deleteBranch = atom(false);
  const open = atom(false);
  const box = atom.lazy(() => newLiveRef<HTMLElement>())();
  const trigger = atom.lazy(() => newLiveRef<HTMLButtonElement>())();
  const reason = mergeStateFacts(detail.mergeState).label;

  // The head branch's own environment, when it has one: deleting the branch
  // deletes the environment and everything it stored.
  const environment = (resourceValue(environments(appId).state()) ?? []).find(
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
            {notice === null ? null : (
              <p class="text-error m-0 text-sm" role="alert">
                {notice}
              </p>
            )}
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={!canMerge || busy}
              onclick={async () => {
                const ok = await runMutation(
                  mutation,
                  "merge",
                  appId,
                  pullRequest.number,
                  async () => {
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
                  }
                );

                if (ok) {
                  open.set(false);
                }
              }}
            >
              {busy ? "Merging…" : "Squash and merge"}
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
  mutation,
  role,
  viewerId,
}: {
  appId: string;
  detail: PrDetail;
  mutation: AtomHandle<PrMutation>;
  role: AppRole | undefined;
  viewerId: string;
}) => {
  const { pullRequest } = detail;
  const capabilities = prCapabilities({ detail, role, viewerId });
  const switchAction = switchStateAction(pullRequest.state, capabilities);
  const busy = mutationRunning(mutation());
  const notice = mutationProblem(mutation(), ["close", "reopen"]);

  if (switchAction === null && !capabilities.canMerge) {
    return null;
  }

  return (
    <div class="flex shrink-0 flex-col items-end gap-1">
      <div class="flex items-center gap-2">
        {switchAction === null ? null : (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={busy}
            onclick={() => {
              void runMutation(
                mutation,
                switchAction === "closed" ? "close" : "reopen",
                appId,
                pullRequest.number,
                async () => {
                  await api<{ ok: true }>("/api/prs/prsUpdate", {
                    appId,
                    number: pullRequest.number,
                    state: switchAction,
                  });
                }
              );
            }}
          >
            {switchAction === "closed" ? "Close" : "Reopen"}
          </button>
        )}
        {capabilities.canMerge ? (
          <MergeDropdown
            appId={appId}
            canMerge={capabilities.canMerge}
            detail={detail}
            mutation={mutation}
          />
        ) : null}
      </div>
      {notice === null ? null : (
        <p class="text-error m-0 text-xs" role="alert">
          {notice}
        </p>
      )}
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

/** The reviewer's own verdict state and the two review buttons. The verdict
 * is one value (`myVerdict`): `current` means it counts at the head sha, so a
 * dismissed approval offers the action again instead of stacking an
 * identical review, and a stale cached detail cannot leave a button disabled
 * for a review the runner no longer counts. */
const ReviewSection = ({
  busy,
  onReview,
  verdict,
}: {
  busy: boolean;
  onReview: (state: "approved" | "changes_requested") => void;
  verdict: MyVerdict;
}) => {
  const approved = verdict._tag === "Approved";
  const requested = verdict._tag === "ChangesRequested";
  const current = verdict._tag !== "None" && verdict.current;

  return (
    <div class="flex flex-col gap-2">
      {approved && current ? (
        <p class="m-0 text-xs opacity-70">You approved this pull request.</p>
      ) : null}
      {requested && current ? (
        <p class="m-0 text-xs opacity-70">
          You requested changes on this pull request.
        </p>
      ) : null}
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-success"
          disabled={busy || (approved && current)}
          onclick={() => {
            onReview("approved");
          }}
        >
          {approved ? "Approve again" : "Approve"}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-error btn-outline"
          disabled={busy || (requested && current)}
          onclick={() => {
            onReview("changes_requested");
          }}
        >
          {requested ? "Change review" : "Request changes"}
        </button>
      </div>
    </div>
  );
};

/** The side box: how the pull ended (when it has), its conflicts, and the
 * review buttons for anyone but the author. Nothing to show — no box. */
export const PrReviewBox = ({
  appId,
  detail,
  mutation,
  role,
  viewerId,
}: {
  appId: string;
  detail: PrDetail;
  mutation: AtomHandle<PrMutation>;
  role: AppRole | undefined;
  viewerId: string;
}) => {
  const { pullRequest } = detail;
  const capabilities = prCapabilities({ detail, role, viewerId });
  const busy = mutationRunning(mutation());
  const notice = mutationProblem(mutation(), ["review"]);
  const conflicts = detail.compare?.conflicts ?? [];
  const ended = pullRequest.state !== "open";
  const verdict = myVerdict(detail, viewerId);

  if (!(capabilities.canReview || conflicts.length > 0 || ended)) {
    return null;
  }

  const review = (state: "approved" | "changes_requested") => {
    void runMutation(
      mutation,
      "review",
      appId,
      pullRequest.number,
      async () => {
        await api<{ ok: true }>("/api/prs/prsReview", {
          appId,
          number: pullRequest.number,
          state,
        });
      }
    );
  };

  return (
    <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-3">
      {ended ? <EndedNotice detail={detail} /> : null}
      {conflicts.length > 0 ? <ConflictList conflicts={conflicts} /> : null}
      {capabilities.canReview ? (
        <ReviewSection busy={busy} onReview={review} verdict={verdict} />
      ) : null}
      {notice === null ? null : (
        <p class="text-error m-0 text-sm" role="alert">
          {notice}
        </p>
      )}
    </section>
  );
};
