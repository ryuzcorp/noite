import { SidebarApps, sidebarPlace } from "$lib/apps/sidebar";
import { authClient } from "$lib/auth-client";
import { Authed } from "$lib/auth/authed";
import { Onboarding } from "$lib/auth/onboarding";
import { invalidateSession } from "$lib/auth/session";
import { session } from "$lib/resources";
import { provideNavigationCell } from "$lib/search-param";
import { Avatar } from "$lib/ui/avatar";
import {
  BookOpen,
  CircleUser,
  List as ListIcon,
  LogOut,
  Menu as MenuIcon,
} from "$lib/ui/icons";
import { createPaneGroup, MORPH_PRESERVE } from "$lib/ui/resizable";
import { ResizeHandle } from "$lib/ui/resize-handle";
import { defineLayout, navigate, useRoute } from "@ilha/router";
import { atom, watch } from "ilha";

/**
 * Global chrome for the dashboard. Excludes the auth page so /login stays
 * bare — the session gate wraps the ENTIRE chrome (nav included), so a
 * logged-out visitor never sees dashboard pixels, not even the sidebar.
 */
const signOut = async () => {
  // Sign out first: invalidating before the cookie is gone refetched (and
  // re-cached) the outgoing user's session.
  await authClient.signOut();
  invalidateSession();
  navigate("/login");
};

/** The sidebar's own split (`$lib/ui/resizable`): it is the same column on
 * every page, so it keeps one width app-wide — the drawer's own `w-60`
 * (240px) until it is dragged, between the room a page needs and the room a
 * sidebar can take. Below `lg` the drawer is the phone nav: nothing is bound
 * and daisyUI's behaviour is untouched. */
const SIDEBAR_PANES = {
  direction: "horizontal",
  key: "app-shell",
  maxPx: [400, null],
  minPx: [200, 0],
  openPx: [240, null],
} as const;

export default defineLayout(({ children }) => {
  // The cell every `searchParam` read subscribes to (see $lib/search-param).
  // It must run on every render, before the /login early return.
  provideNavigationCell();
  // The chrome's own state, like the cell above: the sidebar is part of the
  // shell, so it is created before the /login early return — nothing binds
  // there, because the drawer is not rendered.
  const sidebar = atom.lazy(() => createPaneGroup(SIDEBAR_PANES))();
  watch.once(({ onCleanup }) => {
    onCleanup(() => {
      sidebar.destroy();
    });
  });
  const { path } = useRoute();
  const { activeAppId, activeView, onAppsPages } = sidebarPlace(path());
  const appsItemActive = onAppsPages && activeAppId === null;
  const sessionRes = session();
  const user = sessionRes.data()?.user;
  const displayName = user?.name || user?.email || "";
  if (path() === "/login") {
    return <>{children}</>;
  }
  const sidebarSplit = sidebar.stored(2);

  return (
    <Authed>
      {/* The app shell: the sidebar column and the page beside it. At `lg` and
          up the two are panes of the shell's own split (bound there and
          nowhere else — see $lib/ui/resizable); below `lg` nothing is bound
          and daisyUI's drawer is the phone nav, untouched. The sidebar comes
          first in the DOM because that is the order the split lays out; the
          drawer's own grid places the two either way, and its checkbox (out of
          flow) still precedes the side it opens. */}
      <div
        ref={sidebar.ref}
        class="drawer lg:drawer-open"
        data-slot="resizable"
        data-direction="horizontal"
        data-morph-preserve={MORPH_PRESERVE}
      >
        <input id="nav-drawer" type="checkbox" class="drawer-toggle" />
        {/* `lg:w-60` is the phone drawer's own width, kept at `lg` so the
            column is 240px before the split binds (and measured from it). */}
        <div
          class="drawer-side lg:w-60"
          data-slot="resizable-panel"
          data-default-size={sidebarSplit?.[0]}
          data-morph-preserve={MORPH_PRESERVE}
        >
          <label
            for="nav-drawer"
            class="drawer-overlay"
            aria-label="Close menu"
          />
          {/* `w-60` is the phone drawer's own width; at `lg` the aside fills the
              pane the split gives it (and scrolls, since the pane clips). */}
          <aside class="menu bg-base-200 dark:bg-base-100 border-base-300 min-h-full w-60 border-r p-0 lg:h-full lg:w-full lg:overflow-y-auto">
            <a
              href="/apps"
              class="link menu-title flex items-center gap-2"
              aria-label="Noite dashboard"
            >
              <img src="/logo.svg" alt="" class="h-5 w-auto dark:hidden" />
              <img
                src="/logo-dark.svg"
                alt=""
                class="hidden h-5 w-auto dark:block"
              />
            </a>
            <ul class="menu w-full flex-1">
              <li>
                <a
                  href="/apps"
                  data-tour="apps"
                  class={appsItemActive ? "menu-active" : undefined}
                  aria-current={appsItemActive ? "page" : undefined}
                >
                  <ListIcon class="h-5 w-5 shrink-0" />
                  Apps
                </a>
                {onAppsPages ? (
                  <SidebarApps activeId={activeAppId} activeView={activeView} />
                ) : null}
              </li>
            </ul>
            <div class="border-base-300 border-t p-2">
              <div class="dropdown dropdown-top w-full">
                <div
                  tabindex={0}
                  role="button"
                  data-tour="account"
                  aria-label="Account menu"
                  class="btn btn-sm btn-ghost flex w-full items-center justify-start gap-2 px-2"
                >
                  <Avatar label={displayName} size="sm" />
                  <span class="truncate text-sm">{displayName || "…"}</span>
                </div>
                <ul
                  tabindex={0}
                  class="dropdown-content menu bg-base-100 dark:bg-base-200 rounded-box z-10 w-52 p-2 shadow"
                >
                  <li>
                    <a href="/account">
                      <CircleUser />
                      Account
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://noite.now/introduction/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <BookOpen />
                      Docs
                    </a>
                  </li>
                  <li>
                    <button
                      type="button"
                      class="text-error"
                      onclick={() => {
                        void signOut();
                      }}
                    >
                      <LogOut />
                      Sign out
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </aside>
        </div>
        <ResizeHandle label="Resize sidebar" />
        <div
          class="drawer-content bg-base-200 dark:bg-base-100 flex min-h-screen flex-1 flex-col"
          data-slot="resizable-panel"
          data-default-size={sidebarSplit?.[1]}
          data-morph-preserve={MORPH_PRESERVE}
        >
          {/* Phones: a real top bar instead of a floating button, so the
              menu toggle never sits on top of page content. */}
          <div class="bg-base-200/90 dark:bg-base-100/90 border-base-300 sticky top-0 z-40 flex items-center gap-2 border-b px-2 py-2 backdrop-blur lg:hidden">
            <label
              for="nav-drawer"
              class="btn btn-sm btn-ghost btn-square"
              aria-label="Open menu"
            >
              <MenuIcon class="h-5 w-5" />
            </label>
            <a href="/apps" class="inline-flex" aria-label="Noite dashboard">
              <img src="/logo.svg" alt="" class="h-5 w-auto dark:hidden" />
              <img
                src="/logo-dark.svg"
                alt=""
                class="hidden h-5 w-auto dark:block"
              />
            </a>
          </div>
          {children}
        </div>
      </div>
      <Onboarding />
    </Authed>
  );
});
