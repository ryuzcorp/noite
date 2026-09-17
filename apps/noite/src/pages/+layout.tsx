import { initials } from "$lib/apps";
import { authClient, hardNav } from "$lib/auth-client";
import { Authed, clearSessionCache } from "$lib/authed";
import { defineLayout, useRoute } from "@ilha/router";
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
const GLOBE =
  '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20M2 12h20"/>';
const HARD_DRIVE =
  '<path d="M10 16h.01m-7.798-4.423a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zm19.734.436H2.054M6 16h.01"/>';
const TOGGLE_RIGHT =
  '<circle cx="15" cy="12" r="3"/><rect width="20" height="14" x="2" y="5" rx="7"/>';

const signOut = async () => {
  clearSessionCache();
  await authClient.signOut();
  hardNav("/login");
};

export default defineLayout(({ children }) => {
  const { path } = useRoute();
  const displayName = atom("");
  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      displayName.set(data?.user?.name || data?.user?.email || "");
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
            class="btn btn-ghost btn-sm fixed top-3 left-3 z-40 lg:hidden"
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
          <aside class="menu bg-base-200 dark:bg-base-100 border-base-300 min-h-full w-60 border-r">
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
              <li>
                <a class="cursor-default" aria-disabled="true">
                  {unsafe(lucideIcon(GLOBE))}
                  Domains
                </a>
              </li>
              <li>
                <a
                  href="/storage"
                  class={
                    path().startsWith("/storage") ? "menu-active" : undefined
                  }
                >
                  {unsafe(lucideIcon(HARD_DRIVE))}
                  Storage
                </a>
              </li>
              <li>
                <a class="cursor-default" aria-disabled="true">
                  {unsafe(lucideIcon(TOGGLE_RIGHT))}
                  Feature Flags
                </a>
              </li>
            </ul>
            <div class="border-base-300 border-t p-2">
              <div class="dropdown dropdown-top w-full">
                <div
                  tabindex={0}
                  role="button"
                  aria-label="Account menu"
                  class="btn btn-ghost flex w-full items-center justify-start gap-2 px-2"
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
                  class="dropdown-content menu bg-base-100 rounded-box z-10 w-52 p-2 shadow"
                >
                  <li>
                    <a href="/profile">Account</a>
                  </li>
                  <li>
                    <button
                      type="button"
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
