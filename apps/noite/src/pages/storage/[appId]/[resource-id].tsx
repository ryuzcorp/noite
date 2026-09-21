import { StorageDetail } from "$lib/storage/detail";
import { resourceDisplayName } from "$lib/storage/list";
import { useRoute, head } from "@ilha/router";
import { watch } from "ilha";

export default function StorageDetailPage() {
  const { params } = useRoute();
  const { appId, "resource-id": resourceId } = params();
  head({ title: "Storage · Noite" });

  // Tab title follows the resource (head() only applies on mount).
  watch.once(() => {
    if (!resourceId || typeof document === "undefined") {
      return;
    }
    document.title = `${resourceDisplayName(resourceId)} · Noite`;
  });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      {appId && resourceId ? (
        <StorageDetail appId={appId} resourceId={resourceId} />
      ) : (
        <p class="m-0 text-sm opacity-70">Missing storage id.</p>
      )}
    </div>
  );
}
