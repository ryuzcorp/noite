import { initials } from "$lib/apps";
import { authClient } from "$lib/auth-client";
import { Authed } from "$lib/authed";
import { List as ListIcon, Menu as MenuIcon } from "$lib/icons";
import { Onboarding } from "$lib/onboarding";
import { session } from "$lib/resources";
import { invalidateSession } from "$lib/session";
import { defineLayout, navigate, useRoute } from "@ilha/router";

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

export default defineLayout(({ children }) => {
  const { path } = useRoute();
  const sessionRes = session();
  const user = sessionRes.data()?.user;
  const displayName = user?.name || user?.email || "";
  if (path() === "/login") {
    return <>{children}</>;
  }

  return (
    <Authed>
      <div class="drawer lg:drawer-open">
        <input id="nav-drawer" type="checkbox" class="drawer-toggle" />
        <div class="drawer-content bg-base-200 dark:bg-base-100 flex min-h-screen flex-1 flex-col">
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
                  data-tour="apps"
                  class={path().startsWith("/apps") ? "menu-active" : undefined}
                >
                  <ListIcon class="h-5 w-5 shrink-0" />
                  Apps
                </a>
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
                  <div class="avatar avatar-placeholder">
                    <div class="bg-neutral text-neutral-content w-8 rounded-full">
                      <span class="text-xs">{initials(displayName)}</span>
                    </div>
                  </div>
                  <span class="truncate text-sm">{displayName || "…"}</span>
                </div>
                <ul
                  tabindex={0}
                  class="dropdown-content menu bg-base-100 dark:bg-base-200 rounded-box z-10 w-52 p-2 shadow"
                >
                  <li>
                    <a href="/account">Account</a>
                  </li>
                  <li>
                    <a
                      href="https://noite.now/introduction/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
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
                      Sign out
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </div>
      <Onboarding />
    </Authed>
  );
});
