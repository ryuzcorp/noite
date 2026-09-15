import { authClient, hardNav } from "$lib/auth-client";
import { Breadcrumbs } from "$lib/breadcrumbs";
import { SourceBrowser } from "$lib/source-browser";
import { head, useRoute } from "@ilha/router";
import { atom, watch } from "ilha";

/** Source preview for one app — files of the latest pushed commit. */
export default function Source() {
  const { params } = useRoute();
  const ready = atom(false);
  const appId = params().id;
  head({ title: "Source · Noite" });

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        hardNav("/login");
        return;
      }
      ready.set(true);
    })();
  });

  if (!ready()) {
    return <p class="opacity-70">Loading…</p>;
  }
  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }
  return (
    <div class="mx-auto mt-8 flex max-w-5xl flex-col gap-4 px-4 pb-12">
      <Breadcrumbs
        trail={[
          { href: "/apps", label: "Apps" },
          { href: `/apps/${appId}`, label: "App" },
          { label: "Source" },
        ]}
      />
      <SourceBrowser appId={appId} />
    </div>
  );
}
