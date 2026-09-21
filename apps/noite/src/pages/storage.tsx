import { StorageList } from "$lib/storage/list";
import { head } from "@ilha/router";

export default function StoragePage() {
  head({ title: "Storage · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <StorageList />
    </div>
  );
}
