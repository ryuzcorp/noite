/** Compare page body: base…head commits, three-dot diff and the squash-merge
 * verdict. This is the entry point for "Open pull request" (the PullRequests
 * slice adds that button; nothing renders for it yet). */
import { SectionSkeleton } from "../ui/skeletons";
import { RefField } from "./branches";
import { forgeCompare } from "./data";
import { DiffView } from "./diff";
import { loadState } from "./load";
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
  <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
    <RefField
      appId={appId}
      caption="Base"
      value={base}
      onChange={(next) => {
        onPick(next, head);
      }}
    />
    {/* Between the two, and only while they sit on one row (see the new-PR
     * form's pickers). */}
    <span aria-hidden="true" class="hidden pb-2 opacity-50 sm:inline">
      ←
    </span>
    <RefField
      appId={appId}
      caption="Head"
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
  gitRef,
  head,
  onPick,
}: {
  appId: string;
  base: string;
  /** The browsed ref (the branch the compare was opened from), carried into
   * the commit links so their back link returns to it. */
  gitRef: string;
  head: string;
  onPick: (base: string, head: string) => void;
}) => {
  const res = forgeCompare(appId, base, head);
  const load = loadState(res.state());

  if (load._tag !== "Ready") {
    return (
      <div class="flex flex-col gap-6">
        <CompareBar appId={appId} base={base} head={head} onPick={onPick} />
        {load._tag === "Loading" ? (
          <SectionSkeleton lines={5} />
        ) : (
          <p class="text-error m-0 text-sm">
            Failed to compare: {load.message}
          </p>
        )}
      </div>
    );
  }

  const data = load.value;

  return (
    <div class="flex flex-col gap-6">
      <CompareBar appId={appId} base={base} head={head} onPick={onPick} />
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
            gitRef={gitRef}
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
    </div>
  );
};
