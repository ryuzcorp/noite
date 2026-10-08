import { PullsPage } from "$lib/prs/layout";
import { NewPrForm } from "$lib/prs/new";
import { searchParam } from "$lib/search-param";
import { head, useRoute } from "@ilha/router";

/** New pull (`/apps/[id]/pulls/new`). Base defaults to `main`; head, and a
 * prefilled title, can arrive from the Changes panel or Compare. */
export default function NewPrPage() {
  const appId = useRoute().params().id;
  const base = searchParam("base", { default: "main" });
  const headRef = searchParam("head", { default: "" });
  const title = searchParam("title", { default: "" });
  head({ title: "New pull · Noite" });
  if (!appId) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id.</p>;
  }
  return (
    <PullsPage appId={appId} back>
      <h1 class="m-0 text-xl font-semibold">New pull</h1>
      <NewPrForm
        key={`${appId}:${base()}:${headRef()}`}
        appId={appId}
        baseDefault={base()}
        headDefault={headRef()}
        titleDefault={title()}
      />
    </PullsPage>
  );
}
