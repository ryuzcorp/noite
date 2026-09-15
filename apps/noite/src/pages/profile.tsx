import { Breadcrumbs } from "$lib/breadcrumbs";
import { ProfilePanel } from "$lib/profile-panel";
import { head } from "@ilha/router";

export default function Profile() {
  head({ title: "Profile · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <Breadcrumbs trail={[{ label: "Profile" }]} />
      <div class="w-full max-w-2xl">
        <ProfilePanel />
      </div>
    </div>
  );
}
