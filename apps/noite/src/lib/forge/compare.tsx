/** Compare page body: base…head commits, three-dot diff and the squash-merge
 * verdict. This is the entry point for "Open pull request" (the PullRequests
 * slice adds that button; nothing renders for it yet). */
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";
import { RefSelect } from "./branches";
import { forgeCompare } from "./data";
import { DiffView } from "./diff";
import { CommitList, FileStats } from "./parts";

/** Base/head pickers, shared by the compare page's empty and loaded states. */
export const CompareBar = ({
  appId,
  base,
  head,
  onPick,
}: {
  appId: string;
  base: string;
  head: string;
  onPick: (base: string, head: string) => void;
}) => (
  <div class="flex flex-wrap items-center gap-2">
    <RefSelect
      appId={appId}
      label="Base ref"
      value={base}
      onChange={(next) => {
        onPick(next, head);
      }}
    />
    <span aria-hidden="true" class="opacity-50">
      ←
    </span>
    <RefSelect
      appId={appId}
      label="Head ref"
      value={head}
      onChange={(next) => {
        onPick(base, next);
      }}
    />
  </div>
);

export const CompareView = ({
  appId,
  base,
  head,
  onPick,
}: {
  appId: string;
  base: string;
  head: string;
  onPick: (base: string, head: string) => void;
}) => {
  const res = forgeCompare(appId, base, head);
  const data = res.data();
  const error = res.error();
  return (
    <div class="flex flex-col gap-6">
      <CompareBar appId={appId} base={base} head={head} onPick={onPick} />
      {data === undefined ? (
        <>
          <LoadError error={error} label="Failed to compare" />
          {error ? null : <SectionSkeleton lines={5} />}
        </>
      ) : (
        <>
          <header class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-mono">{base}</span>
            <span aria-hidden="true" class="opacity-50">
              ←
            </span>
            <span class="font-mono">{head}</span>
            {data.mergeable ? (
              <span class="badge badge-sm">ready to squash-merge</span>
            ) : (
              <span class="badge badge-sm badge-error">
                {data.conflicts.length} conflict
                {data.conflicts.length === 1 ? "" : "s"}
              </span>
            )}
            <span class="text-base-content/70">
              {data.ahead} commit{data.ahead === 1 ? "" : "s"} ahead ·{" "}
              {data.behind} behind {base}
            </span>
          </header>
          {data.mergeable ? null : (
            <ul class="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {data.conflicts.map((path) => (
                <li key={path} class="font-mono text-xs">
                  {path}
                </li>
              ))}
            </ul>
          )}
          <section class="flex flex-col gap-2">
            <h2 class="m-0 text-lg font-semibold">
              Commits <span class="badge badge-sm">{data.commits.length}</span>
            </h2>
            <CommitList
              appId={appId}
              commits={data.commits}
              emptyLabel="No commits between the refs."
            />
          </section>
          <section class="flex flex-col gap-2">
            <h2 class="m-0 text-lg font-semibold">
              Files changed{" "}
              <span class="badge badge-sm">{data.files.length}</span>
            </h2>
            <FileStats files={data.files} />
          </section>
          <section class="flex flex-col gap-2">
            <h2 class="m-0 text-lg font-semibold">Diff</h2>
            {data.patch === "" ? (
              <p class="m-0 text-sm opacity-70">No changes between the refs.</p>
            ) : (
              <div class="border-base-300 overflow-hidden rounded-lg border">
                <DiffView
                  key={`${data.baseSha}:${data.headSha}`}
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
        </>
      )}
    </div>
  );
};
