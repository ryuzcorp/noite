import { AppsList } from "$lib/apps/list";
import { head } from "$lib/navigation";

export default function AppsPage() {
  head({ title: "Apps · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <AppsList />
    </div>
  );
}
