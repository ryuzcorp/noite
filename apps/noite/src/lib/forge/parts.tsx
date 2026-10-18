/** Shared forge rows: commit lists and changed-file stats. */
import { Link } from "@ilha/void";

import { formatAgo } from "../dates";
import type { GitCommitSummary, GitFileStat } from "../runner";
import { commitHref, gitTime, shortSha } from "./format";

const STATUS_LABEL: Record<GitFileStat["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

/** One changed path: status, path (plus its old path when renamed) and the
 * addition/deletion counts (null counts are binary files). */
export const FileStatRow = ({ file }: { file: GitFileStat }) => (
  <li class="flex items-center gap-2 py-1 text-sm">
    <span class="badge badge-sm badge-ghost w-6 font-mono">
      {STATUS_LABEL[file.status]}
    </span>
    <span class="min-w-0 flex-1 truncate font-mono text-xs">
      {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    </span>
    <span class="shrink-0 font-mono text-xs tabular-nums opacity-70">
      {file.additions === null || file.deletions === null
        ? "bin"
        : `+${file.additions} −${file.deletions}`}
    </span>
  </li>
);

/** The changed-file summary of a commit or compare. */
export const FileStats = ({ files }: { files: GitFileStat[] }) => {
  if (files.length === 0) {
    return <p class="m-0 text-sm opacity-70">No files changed.</p>;
  }
  return (
    <ul class="m-0 flex list-none flex-col p-0">
      {files.map((file) => (
        <FileStatRow
          key={`${file.status}:${file.oldPath ?? ""}:${file.path}`}
          file={file}
        />
      ))}
    </ul>
  );
};

/** A commit list with an empty state: per commit its subject (linking to its
 * page), author, relative time and short SHA. The rows are written inline,
 * not as a component: a component's row sits in its own `display: contents`
 * wrapper, so `last:` would match every row and drop every divider. */
export const CommitList = ({
  appId,
  commits,
  emptyLabel,
  file = "",
  gitRef = "",
  showParents = false,
}: {
  appId: string;
  commits: GitCommitSummary[];
  emptyLabel: string;
  /** The open file, carried into each commit link so its back link returns to
   * it (see `commitHref`). */
  file?: string;
  /** The browsed ref, carried into each commit link the same way. */
  gitRef?: string;
  showParents?: boolean;
}) => {
  if (commits.length === 0) {
    return <p class="m-0 text-sm opacity-70">{emptyLabel}</p>;
  }
  const from = { file, ref: gitRef };
  return (
    <ul class="m-0 flex list-none flex-col p-0 text-sm">
      {commits.map((commit) => (
        <li
          key={commit.sha}
          class="border-base-300 flex items-start gap-2 border-b py-2 last:border-0"
        >
          <div class="min-w-0 flex-1">
            <Link
              class="link link-hover line-clamp-2 font-medium break-words"
              href={commitHref(appId, commit.sha, from)}
              title={commit.subject}
            >
              {commit.subject}
            </Link>
            <div class="text-base-content/70 flex flex-wrap items-center gap-x-1.5 text-xs">
              <span>{commit.authorName}</span>
              <span aria-hidden="true">·</span>
              <span>{formatAgo(gitTime(commit.authoredAt))}</span>
              {showParents && commit.parents.length > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>parent{commit.parents.length > 1 ? "s" : ""}</span>
                  {commit.parents.map((parent) => (
                    <Link
                      key={parent}
                      class="link link-hover font-mono"
                      href={commitHref(appId, parent, from)}
                      title={parent}
                    >
                      {shortSha(parent)}
                    </Link>
                  ))}
                </>
              ) : null}
            </div>
          </div>
          <Link
            class="link link-hover text-base-content/70 shrink-0 font-mono text-xs"
            href={commitHref(appId, commit.sha, from)}
            title={commit.sha}
          >
            {shortSha(commit.sha)}
          </Link>
        </li>
      ))}
    </ul>
  );
};
