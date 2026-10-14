/** Pull-request Files tab: the live `base..head` diff, one viewer per file,
 * clickable lines that open an anchored comment composer, and one thread per
 * anchored comment. Outdated comments are left to the Conversation tab. */
import { atom } from "ilha";

import { DiffView } from "../forge/diff";
import type { AppRole } from "../roles";
import type { PrDetail } from "../runner";
import { groupLineComments, isLargeDiff, splitPatchFiles } from "./data";
import type { LineThread } from "./data";
import { CommentCard, CommentComposer, SIDE_LABEL } from "./widgets";
import type { ComposerAnchor } from "./widgets";

/** A file's diff over the large-diff thresholds, collapsed until asked for. */
const LargeDiff = ({ patch }: { patch: string }) => {
  const shown = atom(false);
  return (
    <div class="border-base-300 flex flex-col items-start gap-2 rounded-lg border p-3">
      {shown() ? (
        <div class="w-full">
          <DiffView emptyLabel="(no changes)" patch={patch} />
        </div>
      ) : (
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onclick={() => {
            shown.set(true);
          }}
        >
          Large diff — show anyway
        </button>
      )}
    </div>
  );
};

/** One thread's reply state: a composer while replying, a Reply link
 * otherwise. Rendered only when the viewer can comment. */
const ReplyBox = ({
  appId,
  commitSha,
  number,
  thread,
}: {
  appId: string;
  commitSha: string;
  number: number;
  thread: LineThread;
}) => {
  const replying = atom(false);
  if (!replying()) {
    return (
      <button
        type="button"
        class="link link-hover w-fit text-xs"
        onclick={() => {
          replying.set(true);
        }}
      >
        Reply
      </button>
    );
  }
  return (
    <div class="flex flex-col gap-2">
      <CommentComposer
        appId={appId}
        anchor={{ ...thread.anchor, commitSha }}
        number={number}
        placeholder="Reply"
        submitLabel="Reply"
        onPosted={() => {
          replying.set(false);
        }}
      />
      <button
        type="button"
        class="link link-hover w-fit text-xs"
        onclick={() => {
          replying.set(false);
        }}
      >
        Cancel
      </button>
    </div>
  );
};

const Thread = ({
  appId,
  canComment,
  commitSha,
  number,
  thread,
  names,
  role,
  viewerId,
}: {
  appId: string;
  canComment: boolean;
  commitSha: string;
  number: number;
  thread: LineThread;
  names: Record<string, string> | undefined;
  role: AppRole | undefined;
  viewerId: string;
}) => (
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
    {canComment ? (
      <ReplyBox
        appId={appId}
        commitSha={commitSha}
        number={number}
        thread={thread}
      />
    ) : null}
  </div>
);

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
  const canComment = role === "push" || role === "admin";

  return (
    <div class="flex flex-col gap-6">
      {canComment ? null : (
        <p class="text-base-content/70 m-0 text-sm">
          You need push access to comment.
        </p>
      )}
      {files.map((file) => {
        const stat = compare.files.find((entry) => entry.path === file.path);
        const touchesFile = active()?.path === file.path;
        const composer = touchesFile ? active() : null;
        const fileThreads = (threads.get(file.path) ?? [])
          .map((thread) => ({
            anchor: thread.anchor,
            comments: thread.comments.filter((comment) => !comment.outdated),
          }))
          .filter((thread) => thread.comments.length > 0);
        const large = isLargeDiff(
          file.patch,
          stat?.additions ?? null,
          stat?.deletions ?? null
        );
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
              {canComment ? (
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
              ) : null}
            </header>
            {large ? (
              <LargeDiff patch={file.patch} />
            ) : (
              <div class="border-base-300 overflow-hidden rounded-lg border">
                <DiffView
                  key={canComment ? "commentable" : "read-only"}
                  emptyLabel="(no changes)"
                  onLineClick={
                    canComment
                      ? (hit) => {
                          active.set({
                            commitSha: compare.headSha,
                            line: hit.line,
                            path: file.path,
                            side: hit.side,
                          });
                        }
                      : undefined
                  }
                  patch={file.patch}
                />
              </div>
            )}
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
                canComment={canComment}
                commitSha={compare.headSha}
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
