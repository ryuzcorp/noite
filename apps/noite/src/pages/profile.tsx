import { Breadcrumbs } from "$lib/breadcrumbs";
import { ProfilePanel } from "$lib/profile-panel";
import { head } from "@ilha/router";

export default function Profile() {
  head({ title: "Profile · Noite" });

  return (
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6 pt-14 lg:pt-6">
      <Breadcrumbs trail={[{ label: "Profile" }]} />
      <ProfilePanel />
    </div>
  );
}
