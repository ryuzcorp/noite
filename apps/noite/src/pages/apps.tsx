import { AppsList } from "$lib/apps";
import { Authed } from "$lib/authed";
import { head } from "@ilha/router";

export default function AppsPage() {
  head({ title: "Apps · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <Authed>
        <AppsList />
      </Authed>
    </div>
  );
}
