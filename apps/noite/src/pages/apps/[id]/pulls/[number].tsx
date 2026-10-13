import { PrDetailView } from "$lib/prs/detail";
import { PullsPage } from "$lib/prs/layout";
import { head, useRoute } from "@ilha/router";

/** One pull (`/apps/[id]/pulls/[number]`). */
export default function PrPage() {
  const { params } = useRoute();
  const { id: appId, number: raw } = params();
  head({ title: `Pull #${raw ?? ""} · Noite` });
  const number = Math.trunc(Number(raw));
  if (!appId) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id.</p>;
  }
  if (!(Number.isSafeInteger(number) && number > 0)) {
    return <p class="text-error m-0 p-4 text-sm">Missing pull.</p>;
  }
  return (
    <PullsPage appId={appId} back>
      <PrDetailView key={`${appId}:${number}`} appId={appId} number={number} />
    </PullsPage>
  );
}
