import { adminOverview } from "$lib/admin.server";
import { initials } from "$lib/apps";
import { authClient } from "$lib/auth-client";
import { Authed, clearSessionCache } from "$lib/authed";
import { fetchSession, invalidateSession } from "$lib/session";
import { defineLayout, navigate, useRoute } from "@ilha/router";
import { atom, unsafe, watch } from "ilha";

/**
 * Global chrome for the dashboard. Excludes the auth page so /login stays
 * bare — the session gate wraps the ENTIRE chrome (nav included), so a
 * logged-out visitor never sees dashboard pixels, not even the sidebar.
 */
/** Lucide menu icons as static trusted markup (no user input). unsafe()
 * parses in the SVG namespace, which inline <svg> JSX can't reach under
 * ilha's HTML-namespace mounting. Bodies from lucide; stroke inherits the
 * menu text color via currentColor. */
const lucideIcon = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5 shrink-0" aria-hidden="true">${body}</svg>`;

const LAYOUT_LIST =
  '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 4h7m-7 5h7m-7 6h7m-7 5h7"/>';

const signOut = async () => {
  clearSessionCache();
  invalidateSession();
  await authClient.signOut();
  navigate("/login");
};

export default defineLayout(({ children }) => {
  const { path } = useRoute();
  const displayName = atom("");
  const isAdmin = atom(false);
  watch.once(() => {
    void (async () => {
      const { data } = await fetchSession();
      displayName.set(data?.user?.name || data?.user?.email || "");
      if (data?.user) {
        try {
          const overview = await adminOverview();
          isAdmin.set(overview.isAdmin);
        } catch {
          isAdmin.set(false);
        }
      }
    })();
  });
  if (path() === "/login") {
    return <>{children}</>;
  }

  return (
    <Authed>
      <div class="drawer lg:drawer-open">
        <input id="nav-drawer" type="checkbox" class="drawer-toggle" />
        <div class="drawer-content bg-base-200 dark:bg-base-100 flex min-h-screen flex-1 flex-col">
          <label
            for="nav-drawer"
            class="btn btn-sm btn-ghost fixed top-3 left-3 z-40 lg:hidden"
            aria-label="Open menu"
          >
            <svg
              class="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
          </label>
          {children}
        </div>
        <div class="drawer-side">
          <label
            for="nav-drawer"
            class="drawer-overlay"
            aria-label="Close menu"
          />
          <aside class="menu bg-base-200 dark:bg-base-100 border-base-300 min-h-full w-60 border-r p-0">
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
                  class={path().startsWith("/apps") ? "menu-active" : undefined}
                >
                  {unsafe(lucideIcon(LAYOUT_LIST))}
                  Apps
                </a>
              </li>
            </ul>
            <div class="border-base-300 border-t p-2">
              <div class="dropdown dropdown-top w-full">
                <div
                  tabindex={0}
                  role="button"
                  aria-label="Account menu"
                  class="btn btn-sm btn-ghost flex w-full items-center justify-start gap-2 px-2"
                >
                  <div class="avatar avatar-placeholder">
                    <div class="bg-neutral text-neutral-content w-8 rounded-full">
                      <span class="text-xs">{initials(displayName())}</span>
                    </div>
                  </div>
                  <span class="truncate text-sm">{displayName() || "…"}</span>
                </div>
                <ul
                  tabindex={0}
                  class="dropdown-content menu bg-base-100 dark:bg-base-200 rounded-box z-10 w-52 p-2 shadow"
                >
                  <li>
                    <a href="/profile">Account</a>
                  </li>
                  {isAdmin() ? (
                    <li>
                      <a href="/god-mode">God Mode</a>
                    </li>
                  ) : null}
                  <li>
                    <button
                      type="button"
                      class="text-error"
                      onclick={() => {
                        void signOut();
                      }}
                    >
                      Sign out
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </Authed>
  );
});
