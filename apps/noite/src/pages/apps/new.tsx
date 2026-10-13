import { CreateAppForm } from "$lib/apps/create-form";
import { head } from "@ilha/router";

export default function NewAppPage() {
  head({ title: "New app · Noite" });

  return (
    <div class="mx-auto w-full max-w-3xl px-4 pt-6 pb-12">
      <CreateAppForm />
    </div>
  );
}
