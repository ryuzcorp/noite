import { authClient, hardNav } from "$lib/auth-client";
import { PageSkeleton } from "$lib/skeletons";
import { requestSourceMode, SourceBrowser } from "$lib/source-browser";
import type { SourceMode } from "$lib/source-browser";
import { head, navigate, useRoute } from "@ilha/router";
import { atom, watch } from "ilha";

/** Source preview for one app — files of the latest pushed commit. */
export default function Source() {
  const route = useRoute();
  const ready = atom(false);
  const appId = route.params().id;
  head({ title: "Source · Noite" });

  // View lives in ?view= so refresh and deep links restore it; unknown
  // values fall back to files. NOTE: this page must not read reactive
  // state in JSX after mount — a parent re-render disposes the unkeyed
  // SourceBrowser hole and remounts it, rerunning its slow setup and
  // resetting to files. Toggle styling therefore syncs imperatively
  // from the browser by id (like the status line).
  const selectView = (view: SourceMode) => {
    navigate(`${route.path()}?view=${view}`, { replace: true });
    requestSourceMode(view);
  };
  const viewFromUrl = (): SourceMode => {
    const v = new URLSearchParams(route.search()).get("view");
    return v === "diff" ? "diff" : "files";
  };

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

  // Back/forward buttons change the URL without a toggle click —
  // re-apply the panes to match. Untracked read: no subscription,
  // no re-render, no remount.
  watch.once(() => {
    const sync = () => {
      requestSourceMode(viewFromUrl());
    };
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
    };
  });

  if (!ready()) {
    return <PageSkeleton />;
  }
  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }
  return (
    <div class="mt-4 flex min-h-0 w-full flex-1 flex-col gap-4 px-4 pb-12">
      <div class="flex items-center justify-end gap-2">
        <div class="join">
          <button
            id="noite-src-view-files"
            type="button"
            class="btn btn-sm join-item btn-neutral"
            onclick={() => {
              selectView("files");
            }}
          >
            Files
          </button>
          <button
            id="noite-src-view-diff"
            type="button"
            class="btn btn-sm join-item btn-ghost"
            onclick={() => {
              selectView("diff");
            }}
          >
            Last push diff
          </button>
        </div>
      </div>
      <SourceBrowser appId={appId} />
    </div>
  );
}
