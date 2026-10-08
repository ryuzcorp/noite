/** Shared forge rows: commit lists and changed-file stats. */
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

/** One commit: subject linking to its page, author and relative time. */
export const CommitRow = ({
  appId,
  commit,
  showParents = false,
}: {
  appId: string;
  commit: GitCommitSummary;
  showParents?: boolean;
}) => (
  <li class="flex flex-col gap-0.5 px-1 py-2">
    <a
      class="link link-hover min-w-0 truncate font-medium"
      href={commitHref(appId, commit.sha)}
      title={commit.subject}
    >
      {commit.subject}
    </a>
    <div class="text-base-content/70 flex flex-wrap items-center gap-x-2 text-xs">
      <span>{commit.authorName}</span>
      <span aria-hidden="true">·</span>
      <span>{formatAgo(gitTime(commit.authoredAt))}</span>
      <a
        class="link link-hover font-mono"
        href={commitHref(appId, commit.sha)}
        title={commit.sha}
      >
        {shortSha(commit.sha)}
      </a>
      {showParents && commit.parents.length > 0 ? (
        <span class="flex items-center gap-1">
          <span aria-hidden="true">·</span>
          <span>parent{commit.parents.length > 1 ? "s" : ""}</span>
          {commit.parents.map((parent) => (
            <a
              key={parent}
              class="link link-hover font-mono"
              href={commitHref(appId, parent)}
              title={parent}
            >
              {shortSha(parent)}
            </a>
          ))}
        </span>
      ) : null}
    </div>
  </li>
);

/** A commit list with an empty state. */
export const CommitList = ({
  appId,
  commits,
  emptyLabel,
  showParents = false,
}: {
  appId: string;
  commits: GitCommitSummary[];
  emptyLabel: string;
  showParents?: boolean;
}) => {
  if (commits.length === 0) {
    return <p class="m-0 text-sm opacity-70">{emptyLabel}</p>;
  }
  return (
    <ul class="divide-base-300 m-0 flex list-none flex-col divide-y p-0">
      {commits.map((commit) => (
        <CommitRow
          key={commit.sha}
          appId={appId}
          commit={commit}
          showParents={showParents}
        />
      ))}
    </ul>
  );
};
