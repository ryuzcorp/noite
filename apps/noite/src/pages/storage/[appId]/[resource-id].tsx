import { Authed } from "$lib/authed";
import { StorageDetail } from "$lib/storage";
import { useRoute, head } from "@ilha/router";

export default function StorageDetailPage() {
  const { params } = useRoute();
  const { appId, "resource-id": resourceId } = params();
  head({ title: "Storage · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-2xl flex-col gap-4 px-4 pb-12">
      <Authed>
        {appId && resourceId ? (
          <StorageDetail appId={appId} resourceId={resourceId} />
        ) : (
          <p class="m-0 text-sm opacity-70">Missing storage id.</p>
        )}
      </Authed>
    </div>
  );
}
