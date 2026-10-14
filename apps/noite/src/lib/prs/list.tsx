/** Pull-request list: the state tabs the Pull requests page's header shows,
 * and the body — rows and paging (`/apps/[id]/pulls`). */
import { watch } from "ilha";

import { formatAgo } from "../dates";
import type { SearchParam } from "../search-param";
import { LoadError } from "../ui/load-error";
import { ListSkeleton } from "../ui/skeletons";
import type { PrStateFilter } from "./data";
import { PR_PAGE_SIZE, prList, prNames } from "./resources";
import { nameFor, PrStateBadge } from "./widgets";

/** The state tabs, in the order the header shows them. */
export const PR_FILTERS: readonly { id: PrStateFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "merged", label: "Merged" },
  { id: "all", label: "All" },
];

/** The list body for one state and page (`?state=` / `?skip=`, so a refresh
 * or a shared link keeps them). The rows are written inline, not as a row
 * component: a component's root sits in its own `display: contents` wrapper,
 * and the list's row dividers key on `:last-child`. */
export const PrsList = ({
  appId,
  skip,
  state,
}: {
  appId: string;
  skip: SearchParam<number>;
  state: PrStateFilter;
}) => {
  const res = prList(appId, state, skip());
  const data = res.data();
  const error = res.error();
  const pulls = data?.pullRequests ?? [];
  const names = prNames(
    appId,
    pulls.map((pull) => pull.authorId)
  ).data();
  const loading = data === undefined && error === undefined;
  // A deletion can leave `?skip=` past the end (and the page empty): clamp it
  // back to the page that holds the last row. Reacting to the resource's
  // answer keeps the write out of render.
  watch(res.data, (value) => {
    if (value === undefined || value.pullRequests.length > 0 || skip() === 0) {
      return;
    }
    const known =
      state === "all"
        ? value.counts.open + value.counts.closed + value.counts.merged
        : value.counts[state];
    if (known > 0) {
      skip.set(
        Math.max(0, (Math.ceil(known / PR_PAGE_SIZE) - 1) * PR_PAGE_SIZE)
      );
    }
  });
  const counts = data?.counts;
  let total: number | undefined;
  if (counts !== undefined) {
    total =
      state === "all"
        ? counts.open + counts.closed + counts.merged
        : counts[state];
  }
  const hasNext =
    total !== undefined && skip() + pulls.length < total && pulls.length > 0;
  let emptyMessage = `No ${state} pull requests.`;
  if (state === "open") {
    emptyMessage = "No open pull requests.";
  } else if (state === "all") {
    emptyMessage = "No pull requests.";
  }
  const compareLink = (
    <a class="link link-hover text-sm" href={`/apps/${appId}/source/compare`}>
      Compare branches on the Compare page →
    </a>
  );

  return (
    <div class="flex flex-col gap-4">
      <LoadError error={error} label="Failed to load pull requests" />
      {loading ? <ListSkeleton rows={4} /> : null}
      {data !== undefined && pulls.length === 0 ? (
        <div class="flex flex-col items-start gap-1">
          <p class="m-0 text-sm opacity-70">{emptyMessage}</p>
          {state === "open" || state === "all" ? compareLink : null}
        </div>
      ) : null}
      {pulls.length > 0 ? (
        <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box m-0 w-full border p-0 shadow-md">
          {pulls.map((pull) => (
            <li key={pull.number} class="list-row items-center">
              <div>
                <PrStateBadge state={pull.state} />
              </div>
              <div class="min-w-0">
                <a
                  class="link link-hover block truncate font-medium"
                  href={`/apps/${appId}/pulls/${pull.number}`}
                  title={pull.title}
                >
                  {pull.title}
                </a>
                <div class="text-base-content/70 flex flex-wrap items-center gap-x-1.5 text-xs">
                  <span class="font-mono">#{pull.number}</span>
                  <span aria-hidden="true">·</span>
                  <span>{nameFor(names, pull.authorId)}</span>
                  <span aria-hidden="true">·</span>
                  <span class="font-mono">
                    <a
                      class="link link-hover"
                      href={`/apps/${appId}/source?ref=${encodeURIComponent(pull.head)}`}
                    >
                      {pull.head}
                    </a>{" "}
                    into{" "}
                    <a
                      class="link link-hover"
                      href={`/apps/${appId}/source?ref=${encodeURIComponent(pull.base)}`}
                    >
                      {pull.base}
                    </a>
                  </span>
                  <a
                    class="link link-hover"
                    href={`/apps/${appId}/source/compare?base=${encodeURIComponent(
                      pull.base
                    )}&head=${encodeURIComponent(pull.head)}`}
                  >
                    Compare
                  </a>
                </div>
              </div>
              <div class="text-base-content/70 flex shrink-0 items-center gap-3 text-xs">
                {pull.commentCount > 0 ? (
                  <span class="tabular-nums">
                    {pull.commentCount} comment
                    {pull.commentCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                <span>{formatAgo(pull.updatedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {total !== undefined && total > PR_PAGE_SIZE ? (
        <div class="flex items-center gap-2 text-sm">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={skip() === 0}
            onclick={() => {
              skip.set(Math.max(0, skip() - PR_PAGE_SIZE));
            }}
          >
            ‹ Newer
          </button>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={!hasNext}
            onclick={() => {
              skip.set(skip() + PR_PAGE_SIZE);
            }}
          >
            Older ›
          </button>
        </div>
      ) : null}
    </div>
  );
};
