/** Pull list: state filter, counts and rows. The body of the Pulls page
 * (`/apps/[id]/pulls`), whose title carries the New button. */
import { formatAgo } from "../dates";
import type { PrSummary } from "../runner";
import { searchParam } from "../search-param";
import { LoadError } from "../ui/load-error";
import { ListSkeleton } from "../ui/skeletons";
import type { PrStateFilter } from "./data";
import { toPrStateFilter } from "./data";
import { PR_PAGE_SIZE, prList, prNames } from "./resources";
import { nameFor, PrStateBadge } from "./widgets";

const FILTERS: { id: PrStateFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "merged", label: "Merged" },
  { id: "all", label: "All" },
];

const toSkip = (raw: string): number => {
  const value = Math.trunc(Number(raw));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

const PrRow = ({
  appId,
  author,
  pull,
}: {
  appId: string;
  author: string;
  pull: PrSummary;
}) => (
  <li class="flex flex-col gap-1 py-3">
    <div class="flex min-w-0 items-center gap-2">
      <a
        class="link link-hover min-w-0 truncate font-medium"
        href={`/apps/${appId}/pulls/${pull.number}`}
        title={pull.title}
      >
        {pull.title}
      </a>
      <span class="text-base-content/70 shrink-0 font-mono text-xs">
        #{pull.number}
      </span>
      <PrStateBadge state={pull.state} />
    </div>
    <div class="text-base-content/70 flex flex-wrap items-center gap-x-2 text-xs">
      <span>{author}</span>
      <span aria-hidden="true">·</span>
      <span class="font-mono">
        {pull.base} ← {pull.head}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {pull.commentCount} comment{pull.commentCount === 1 ? "" : "s"}
      </span>
      <span aria-hidden="true">·</span>
      <span>{formatAgo(pull.updatedAt)}</span>
    </div>
  </li>
);

/** The list body. The filter and page live in `?state=` / `?skip=`, so a
 * refresh or shared link keeps them. */
export const PrsList = ({ appId }: { appId: string }) => {
  const state = searchParam<PrStateFilter>("state", {
    default: "open",
    parse: toPrStateFilter,
  });
  const skip = searchParam<number>("skip", { default: 0, parse: toSkip });
  const res = prList(appId, state(), skip());
  const data = res.data();
  const error = res.error();
  const names = prNames(
    appId,
    data?.pullRequests.map((pull) => pull.authorId) ?? []
  ).data();
  const counts = data?.counts;
  const total =
    counts === undefined ? 0 : counts.open + counts.closed + counts.merged;
  const loading = data === undefined && error === undefined;

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => {
          const count =
            filter.id === "all" ? total : (counts?.[filter.id] ?? 0);
          return (
            <button
              key={filter.id}
              type="button"
              class={`btn btn-sm ${state() === filter.id ? "btn-neutral" : "btn-ghost"}`}
              aria-pressed={state() === filter.id ? "true" : "false"}
              onclick={() => {
                state.set(filter.id);
                skip.set(0);
              }}
            >
              {filter.label}
              {data === undefined ? null : (
                <span class="badge badge-sm tabular-nums">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      <LoadError error={error} label="Failed to load pulls" />
      {loading ? <ListSkeleton rows={4} /> : null}

      {data !== undefined && data.pullRequests.length === 0 ? (
        <div class="border-base-300 flex flex-col items-start gap-2 rounded-lg border p-4">
          <p class="m-0 text-sm opacity-70">
            {state() === "open"
              ? "No open pulls."
              : "No pulls match this filter."}
          </p>
          <a
            class="link link-hover text-sm"
            href={`/apps/${appId}/source/compare`}
          >
            Compare branches on the Compare page →
          </a>
        </div>
      ) : null}

      {data !== undefined && data.pullRequests.length > 0 ? (
        <>
          <ul class="divide-base-300 m-0 flex list-none flex-col divide-y p-0">
            {data.pullRequests.map((pull) => (
              <PrRow
                key={pull.number}
                appId={appId}
                author={nameFor(names, pull.authorId)}
                pull={pull}
              />
            ))}
          </ul>
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
              disabled={data.pullRequests.length < PR_PAGE_SIZE}
              onclick={() => {
                skip.set(skip() + PR_PAGE_SIZE);
              }}
            >
              Older ›
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
};
