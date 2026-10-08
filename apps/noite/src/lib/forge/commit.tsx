/** Commit page body: metadata, body, changed-file stats and the
 * first-parent diff (rendered by the shared pierre viewer). */
import { formatDateTime } from "../dates";
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";
import { forgeCommit } from "./data";
import { DiffView } from "./diff";
import { commitHref, gitTime, shortSha } from "./format";
import { FileStats } from "./parts";

export const CommitView = ({ appId, sha }: { appId: string; sha: string }) => {
  const res = forgeCommit(appId, sha);
  const data = res.data();
  const error = res.error();
  if (data === undefined) {
    return (
      <div class="flex flex-col gap-4">
        <LoadError error={error} label="Failed to load commit" />
        {error ? null : <SectionSkeleton lines={5} />}
      </div>
    );
  }
  const c = data.commit;
  return (
    <div class="flex flex-col gap-6">
      <header class="flex flex-col gap-2">
        <h1 class="m-0 text-xl font-semibold break-words">{c.subject}</h1>
        <p class="text-base-content/70 m-0 flex flex-wrap items-center gap-x-2 text-sm">
          <span>{c.authorName}</span>
          <span aria-hidden="true">·</span>
          <time datetime={gitTime(c.authoredAt).toISOString()}>
            {formatDateTime(gitTime(c.authoredAt))}
          </time>
          <span aria-hidden="true">·</span>
          <span class="font-mono" title={c.sha}>
            {shortSha(c.sha)}
          </span>
          {c.parents.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>parent{c.parents.length > 1 ? "s" : ""}</span>
              {c.parents.map((parent) => (
                <a
                  key={parent}
                  class="link link-hover font-mono"
                  href={commitHref(appId, parent)}
                  title={parent}
                >
                  {shortSha(parent)}
                </a>
              ))}
            </>
          ) : (
            <span class="badge badge-sm badge-ghost">root commit</span>
          )}
        </p>
      </header>
      {data.body === "" ? null : (
        <pre class="bg-base-200 m-0 overflow-auto rounded-lg p-3 font-mono text-sm whitespace-pre-wrap">
          {data.body}
        </pre>
      )}
      <section class="flex flex-col gap-2">
        <h2 class="m-0 text-lg font-semibold">
          Files changed <span class="badge badge-sm">{data.files.length}</span>
        </h2>
        <FileStats files={data.files} />
      </section>
      <section class="flex flex-col gap-2">
        <h2 class="m-0 text-lg font-semibold">Diff</h2>
        {data.patch === "" ? (
          <p class="m-0 text-sm opacity-70">
            No diff against the first parent.
          </p>
        ) : (
          <div class="border-base-300 overflow-hidden rounded-lg border">
            <DiffView
              key={c.sha}
              emptyLabel="(no changes)"
              patch={data.patch}
            />
          </div>
        )}
        {data.truncated ? (
          <p class="m-0 text-xs opacity-70">
            Diff truncated — it exceeds the server's size cap.
          </p>
        ) : null}
      </section>
    </div>
  );
};
