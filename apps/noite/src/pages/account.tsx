import { AccountPanel } from "$lib/account/panel";
import { head } from "@ilha/router";

export default function Account() {
  head({ title: "Account · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div class="w-full max-w-2xl">
        <AccountPanel />
      </div>
    </div>
  );
}
