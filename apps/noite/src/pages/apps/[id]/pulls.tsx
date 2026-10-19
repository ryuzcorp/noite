import { DetailTabs } from "$lib/app-detail/shell";
import type { PrStateFilter } from "$lib/prs/data";
import { toPrStateFilter } from "$lib/prs/data";
import { PullsPage } from "$lib/prs/layout";
import { PR_FILTERS, PrsList } from "$lib/prs/list";
import { prList } from "$lib/prs/resources";
import { parseSkip, searchParam } from "$lib/search-param";
import { Link, useParams } from "@ilha/void";

/** The app's pull requests (`/apps/[id]/pulls`), laid out like the app's own
 * pages: a title row, the state tabs (`?state=`, every count shown) under it,
 * and the list below. */
export default function PullsListPage() {
  const { id: appId } = useParams();
  const state = searchParam<PrStateFilter>("state", {
    default: "open",
    parse: toPrStateFilter,
  });
  const skip = searchParam<number>("skip", { default: 0, parse: parseSkip });
  if (!appId) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id.</p>;
  }
  const counts = prList(appId, state(), skip()).data()?.counts;
  const active = state();
  return (
    <PullsPage
      appId={appId}
      header={
        <>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h1 class="m-0 text-xl font-semibold">Pull requests</h1>
            <Link
              class="btn btn-sm btn-neutral"
              href={`/apps/${appId}/pulls/new`}
            >
              New pull request
            </Link>
          </div>
          <DetailTabs
            active={active}
            counts={
              counts === undefined
                ? undefined
                : {
                    all: counts.open + counts.closed + counts.merged,
                    closed: counts.closed,
                    merged: counts.merged,
                    open: counts.open,
                  }
            }
            idPrefix="prs-list"
            showZeroCounts
            tabs={PR_FILTERS}
            onSelect={(next) => {
              state.set(toPrStateFilter(next));
              skip.set(0);
            }}
          />
        </>
      }
    >
      <div
        id={`prs-list-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`prs-list-tab-${active}`}
        tabindex={0}
        class="flex min-w-0 flex-col gap-4"
      >
        <PrsList key={appId} appId={appId} skip={skip} state={active} />
      </div>
    </PullsPage>
  );
}
