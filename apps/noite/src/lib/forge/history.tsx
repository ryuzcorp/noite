/** History panel body: one page of a ref's commits (optionally scoped to a
 * path), paged by `?skip=` through the runner's `nextSkip` cursor. */
import type { SearchParam } from "../search-param";
import { ListSkeleton } from "../ui/skeletons";
import { forgeLog, LOG_PAGE_SIZE } from "./data";
import { loadState } from "./load";
import { CommitList } from "./parts";

export const HistoryView = ({
  appId,
  file = "",
  gitRef,
  path,
  skip,
}: {
  appId: string;
  /** The open file, carried into commit links so their back link returns to
   * it. */
  file?: string;
  gitRef: string;
  /** Restrict the log to one path (the panel's "Only this file" scope). */
  path: string;
  skip: SearchParam<number>;
}) => {
  const res = forgeLog(appId, gitRef, path, skip());
  const load = loadState(res.state());
  const current = skip();

  if (load._tag === "Loading") {
    return (
      <div class="flex flex-col gap-3">
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (load._tag === "Failed") {
    return (
      <p class="text-error m-0 text-sm">
        Failed to load history: {load.message}
      </p>
    );
  }

  const data = load.value;
  // One page only: both directions are already disabled, so the pager is
  // noise. Hide it rather than show two dead buttons.
  const singlePage = current === 0 && data.nextSkip === null;

  return (
    <div class="flex flex-col gap-3">
      <CommitList
        appId={appId}
        commits={data.commits}
        emptyLabel="No commits on this ref."
        file={file}
        gitRef={gitRef}
      />
      {singlePage ? null : (
        <div class="flex items-center gap-2 text-sm">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={current === 0}
            onclick={() => {
              skip.set(Math.max(0, current - LOG_PAGE_SIZE));
            }}
          >
            ‹ Newer
          </button>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={data.nextSkip === null}
            onclick={() => {
              const next = data.nextSkip;

              if (next !== null) {
                skip.set(next);
              }
            }}
          >
            Older ›
          </button>
        </div>
      )}
    </div>
  );
};
