import { CreateAppForm } from "$lib/apps/create-form";
import { head } from "@ilha/router";

export default function NewAppPage() {
  head({ title: "New app · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 mx-auto w-full max-w-xl border shadow-md">
        <div class="card-body gap-4">
          <p class="text-base-content/80 m-0 text-sm">
            Creating an app provisions a git remote you can push to — deploys
            follow each push. Start empty, copy a public GitHub repo once, or
            begin from a template.
          </p>
          <CreateAppForm />
        </div>
      </div>
    </div>
  );
}
