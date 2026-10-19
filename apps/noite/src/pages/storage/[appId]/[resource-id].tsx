import { StorageDetail } from "$lib/storage/detail";
import { useParams } from "@ilha/void";

export default function StorageDetailPage() {
  const { appId, "resource-id": resourceId } = useParams();

  if (!appId || !resourceId) {
    return (
      <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
        <p class="m-0 text-sm opacity-70">Missing storage id.</p>
      </div>
    );
  }

  // Every storage view is full-height: the D1 editor (sidebar + grid + row
  // panel), the R2 browser (toolbar + listing + detail panel) and the DO
  // viewer (list + preview panel). Height is the viewport minus the
  // small-screen top bar (see the root layout).
  //
  // Keyed: a param change must remount, not reuse, the detail fiber (its
  // resource() slots stay bound to their first key otherwise).
  const key = `${appId}:${resourceId}`;

  return (
    <div class="flex h-[calc(100dvh-3rem)] w-full flex-col overflow-hidden lg:h-dvh">
      <StorageDetail key={key} appId={appId} resourceId={resourceId} />
    </div>
  );
}
