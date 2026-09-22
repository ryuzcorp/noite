import type { AppDetailInfo } from "$lib/app-detail/panel";
import { get } from "$lib/apps.server";
import { fetchSession } from "$lib/session";
import { PageSkeleton } from "$lib/skeletons";
import {
  requestSourceMode,
  requestSourcePush,
  SourceBrowser,
} from "$lib/source-browser";
import type { SourceMode } from "$lib/source-browser";
import { readSwrCache } from "$lib/swr-cache";
import { head, navigate, useRoute } from "@ilha/router";
import { atom, unsafe, watch } from "ilha";

/** Lucide arrow-left, matching the detail page's back link. */
const ARROW_LEFT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';

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

  // Back-link label: seed from the detail SWR cache (instant when arriving
  // from the app page), then refresh from the server. Plain const, not an
  // atom — no subscription, no remount (see the NOTE above).
  const cached = appId
    ? readSwrCache<AppDetailInfo>(`app:${appId}:detail`)
    : null;
  const backName = cached?.app.name ?? "…";

  watch.once(() => {
    void (async () => {
      const { data } = await fetchSession();
      if (!data?.user) {
        navigate("/login");
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

  // Fill the back-link label imperatively (same no-remount rule).
  watch.once(() => {
    if (!appId) {
      return;
    }
    void (async () => {
      try {
        const info = await get(appId);
        const label = document.querySelector("#noite-src-back-name");
        if (label) {
          label.textContent = info.app.name;
        }
      } catch {
        // Label keeps its cached/fallback text.
      }
    })();
  });

  if (!ready()) {
    return <PageSkeleton />;
  }
  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }
  return (
    <div class="flex h-screen w-full flex-col overflow-hidden">
      <div class="border-base-300 flex items-center justify-between gap-2 border-b px-4 py-2">
        <a
          href={`/apps/${appId}`}
          class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
        >
          {unsafe(ARROW_LEFT_SVG)}
          <span id="noite-src-back-name">{backName}</span>
        </a>
        <div class="flex items-center gap-2">
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
          <button
            id="noite-src-push"
            type="button"
            class="btn btn-sm btn-primary"
            disabled
            onclick={() => {
              requestSourcePush();
            }}
          >
            Push
          </button>
        </div>
      </div>
      <SourceBrowser appId={appId} />
    </div>
  );
}
