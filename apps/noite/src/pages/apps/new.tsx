import { CreateAppForm } from "$lib/apps";
import { Breadcrumbs } from "$lib/breadcrumbs";
import { head } from "@ilha/router";

export default function NewAppPage() {
  head({ title: "New app · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <Breadcrumbs
        trail={[{ href: "/apps", label: "Apps" }, { label: "New app" }]}
      />

      <div class="card bg-base-100 mx-auto w-full max-w-xl shadow">
        <div class="card-body gap-4">
          <p class="text-base-content/80 m-0 text-sm">
            Creating an app provisions a git remote you can push to — deploys
            follow each push.
          </p>
          <CreateAppForm />
        </div>
      </div>
    </div>
  );
}
