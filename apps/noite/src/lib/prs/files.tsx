/** Pull-request Files tab: the live `base..head` diff, one viewer per file,
 * clickable lines that open an anchored comment composer, and one thread per
 * anchored comment. Outdated comments are left to the Conversation tab. */
import { atom } from "ilha";

import { DiffView } from "../forge/diff";
import type { AppRole } from "../roles";
import type { PrDetail } from "../runner";
import { groupLineComments, splitPatchFiles } from "./data";
import type { DiffSide, LineThread } from "./data";
import { CommentCard, CommentComposer, SIDE_LABEL } from "./widgets";
import type { ComposerAnchor } from "./widgets";

/** The line a click landed on, read from pierre's rows: content rows carry
 * `data-line`, gutter rows `data-column-number`, both with `data-line-type`. */
const lineFromEvent = (
  event: MouseEvent
): { line: number; side: DiffSide } | null => {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const raw = node.dataset.line ?? node.dataset.columnNumber;
    if (raw === undefined) {
      continue;
    }
    const line = Math.trunc(Number(raw));
    if (!Number.isSafeInteger(line) || line <= 0) {
      continue;
    }
    return {
      line,
      side: (node.dataset.lineType ?? "").includes("deletion") ? "old" : "new",
    };
  }
  return null;
};

const Thread = ({
  appId,
  number,
  thread,
  names,
  role,
  viewerId,
}: {
  appId: string;
  number: number;
  thread: LineThread;
  names: Record<string, string> | undefined;
  role: AppRole | undefined;
  viewerId: string;
}) => {
  const replying = atom(false);
  return (
    <div class="border-base-300 flex flex-col gap-2 border-l-2 pl-3">
      <span class="text-base-content/70 font-mono text-xs">
        {thread.anchor.path}:{thread.anchor.line} ·{" "}
        {SIDE_LABEL[thread.anchor.side]}
      </span>
      {thread.comments.map((comment) => (
        <CommentCard
          key={comment.id}
          appId={appId}
          comment={comment}
          names={names}
          number={number}
          role={role}
          showAnchor={false}
          viewerId={viewerId}
        />
      ))}
      {replying() ? null : (
        <button
          type="button"
          class="link link-hover w-fit text-xs"
          onclick={() => {
            replying.set(true);
          }}
        >
          Reply
        </button>
      )}
    </div>
  );
};

export const PrFilesTab = ({
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
  const active = atom<ComposerAnchor | null>(null);
  const { compare } = detail;
  if (compare === null) {
    return (
      <p class="m-0 text-sm opacity-70">
        The head branch is gone — the diff cannot be computed.
      </p>
    );
  }
  const files = splitPatchFiles(compare.patch);
  if (files.length === 0) {
    return (
      <p class="m-0 text-sm opacity-70">
        No changes between {compare.base} and {compare.head}.
      </p>
    );
  }
  const threads = groupLineComments(detail.comments);

  return (
    <div class="flex flex-col gap-6">
      {files.map((file) => {
        const stat = compare.files.find((entry) => entry.path === file.path);
        const fileThreads = (threads.get(file.path) ?? [])
          .map((thread) => ({
            anchor: thread.anchor,
            comments: thread.comments.filter((comment) => !comment.outdated),
          }))
          .filter((thread) => thread.comments.length > 0);
        const composer = active()?.path === file.path ? active() : null;
        return (
          <section key={file.path} class="flex flex-col gap-2">
            <header class="flex flex-wrap items-center gap-2">
              <h3 class="m-0 font-mono text-sm">{file.path}</h3>
              {stat === undefined ? null : (
                <span class="text-base-content/70 font-mono text-xs tabular-nums">
                  {stat.additions === null || stat.deletions === null
                    ? "binary"
                    : `+${stat.additions} −${stat.deletions}`}
                </span>
              )}
              <button
                type="button"
                class="link link-hover text-xs"
                onclick={() => {
                  active.set({
                    commitSha: compare.headSha,
                    line: 1,
                    path: file.path,
                    side: "new",
                  });
                }}
              >
                Comment on a line
              </button>
            </header>
            <div
              class="border-base-300 overflow-hidden rounded-lg border"
              onclick={(event) => {
                if (!window.getSelection()?.isCollapsed) {
                  return;
                }
                const hit = lineFromEvent(event);
                if (hit) {
                  active.set({
                    commitSha: compare.headSha,
                    line: hit.line,
                    path: file.path,
                    side: hit.side,
                  });
                }
              }}
            >
              <DiffView emptyLabel="(no changes)" patch={file.patch} />
            </div>
            {composer ? (
              <div class="border-base-300 flex flex-col gap-2 rounded-lg border p-3">
                <div class="flex flex-wrap items-center gap-2">
                  <label class="text-xs opacity-70" for={`line-${file.path}`}>
                    Line
                  </label>
                  <input
                    id={`line-${file.path}`}
                    type="number"
                    min="1"
                    class="input input-sm w-24"
                    value={composer.line}
                    oninput={(event) => {
                      const line = Math.trunc(
                        Number(event.currentTarget.value)
                      );
                      if (Number.isSafeInteger(line) && line > 0) {
                        active.set({ ...composer, line });
                      }
                    }}
                  />
                  <select
                    class="select select-sm"
                    aria-label="Diff side"
                    value={composer.side}
                    onchange={(event) => {
                      const side = event.currentTarget.value;
                      if (side === "old" || side === "new") {
                        active.set({ ...composer, side });
                      }
                    }}
                  >
                    <option value="new" selected={composer.side === "new"}>
                      {SIDE_LABEL.new}
                    </option>
                    <option value="old" selected={composer.side === "old"}>
                      {SIDE_LABEL.old}
                    </option>
                  </select>
                  <button
                    type="button"
                    class="link link-hover ml-auto text-xs"
                    onclick={() => {
                      active.set(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                <CommentComposer
                  appId={appId}
                  anchor={composer}
                  number={detail.pullRequest.number}
                  onPosted={() => {
                    active.set(null);
                  }}
                />
              </div>
            ) : null}
            {fileThreads.map((thread) => (
              <Thread
                key={`${thread.anchor.line}:${thread.anchor.side}`}
                appId={appId}
                names={names}
                number={detail.pullRequest.number}
                role={role}
                thread={thread}
                viewerId={viewerId}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
};
