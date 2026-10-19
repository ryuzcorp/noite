import { PrDetailView } from "$lib/prs/detail";
import { PullsPage } from "$lib/prs/layout";
import { useParams } from "@ilha/void";

/** One pull request (`/apps/[id]/pulls/[number]`). The title comes from
 * `pulls/[number].server.ts`. */
export default function PrPage() {
  const { id: appId, number: raw } = useParams();
  const number = Math.trunc(Number(raw));

  if (!appId) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id.</p>;
  }

  if (!(Number.isSafeInteger(number) && number > 0)) {
    return <p class="text-error m-0 p-4 text-sm">Missing pull request.</p>;
  }

  return (
    <PullsPage appId={appId} back>
      <PrDetailView key={`${appId}:${number}`} appId={appId} number={number} />
    </PullsPage>
  );
}
