/** History panel body: one page of a ref's commits (optionally scoped to a
 * path), paged by `?skip=` through the runner's `nextSkip` cursor. */
import type { SearchParam } from "../search-param";
import { LoadError } from "../ui/load-error";
import { ListSkeleton } from "../ui/skeletons";
import { forgeLog, LOG_PAGE_SIZE } from "./data";
import { CommitList } from "./parts";

export const HistoryView = ({
  appId,
  gitRef,
  path,
  skip,
}: {
  appId: string;
  gitRef: string;
  /** Restrict the log to one path (the panel's "Only this file" scope). */
  path: string;
  skip: SearchParam<number>;
}) => {
  const res = forgeLog(appId, gitRef, path, skip());
  const data = res.data();
  const error = res.error();
  const current = skip();
  const loading = data === undefined && error === undefined;
  return (
    <div class="flex flex-col gap-3">
      <LoadError error={error} label="Failed to load history" />
      {loading ? <ListSkeleton rows={6} /> : null}
      {data === undefined ? null : (
        <>
          <CommitList
            appId={appId}
            commits={data.commits}
            emptyLabel="No commits on this ref."
          />
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
        </>
      )}
    </div>
  );
};
