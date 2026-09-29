import { StorageDetail } from "$lib/storage/detail";
import { resourceDisplayName } from "$lib/storage/list";
import { useRoute, head } from "@ilha/router";

export default function StorageDetailPage() {
  const { params } = useRoute();
  const { appId, "resource-id": resourceId } = params();
  head({
    title: `${resourceId ? resourceDisplayName(resourceId) : "Storage"} · Noite`,
  });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      {appId && resourceId ? (
        // Keyed: a param change must remount, not reuse, the detail fiber
        // (its resource() slots stay bound to their first key otherwise).
        <StorageDetail
          key={`${appId}:${resourceId}`}
          appId={appId}
          resourceId={resourceId}
        />
      ) : (
        <p class="m-0 text-sm opacity-70">Missing storage id.</p>
      )}
    </div>
  );
}
