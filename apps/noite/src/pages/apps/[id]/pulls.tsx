import { OpenPrBadge, PullsPage } from "$lib/prs/layout";
import { PrsList } from "$lib/prs/list";
import { head, useRoute } from "@ilha/router";

/** The app's pulls (`/apps/[id]/pulls`). */
export default function PullsListPage() {
  const appId = useRoute().params().id;
  head({ title: "Pulls · Noite" });
  if (!appId) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id.</p>;
  }
  return (
    <PullsPage appId={appId}>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 class="m-0 flex items-center gap-2 text-xl font-semibold">
          Pulls
          <OpenPrBadge appId={appId} showZero />
        </h1>
        <a class="btn btn-sm btn-neutral" href={`/apps/${appId}/pulls/new`}>
          New pull
        </a>
      </div>
      <PrsList key={appId} appId={appId} />
    </PullsPage>
  );
}
