import { authClient, hardNav } from "$lib/auth-client";
import { defineLayout, useRoute } from "@ilha/router";

/**
 * Global chrome for the dashboard. Excludes the auth page so /login stays
 * bare — same nav pattern (daisyUI `menu`) otherwise wraps every view.
 */
export default defineLayout(({ children }) => {
  const { path } = useRoute();
  if (path() === "/login") {
    return <>{children}</>;
  }

  return (
    <div class="drawer lg:drawer-open">
      <input id="nav-drawer" type="checkbox" class="drawer-toggle" />
      <div class="drawer-content flex min-h-screen flex-1 flex-col">
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
        <aside class="menu bg-base-200 min-h-full w-60">
          <a href="/apps" class="link menu-title" aria-label="Noite dashboard">
            Noite
          </a>
          <ul class="menu menu-lg flex-1">
            <li>
              <a
                href="/apps"
                class={path().startsWith("/apps") ? "menu-active" : undefined}
              >
                Apps
              </a>
            </li>
            <li>
              <a class="cursor-default" aria-disabled="true">
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
                Storage
              </a>
            </li>
            <li>
              <a class="cursor-default" aria-disabled="true">
                Feature Flags
              </a>
            </li>
            <li>
              <a
                href="/profile"
                class={
                  path().startsWith("/profile") ? "menu-active" : undefined
                }
              >
                Profile
              </a>
            </li>
          </ul>
          <ul class="menu menu-lg border-base-300 border-t">
            <li>
              <button
                type="button"
                onclick={async () => {
                  await authClient.signOut();
                  hardNav("/login");
                }}
              >
                Sign out
              </button>
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
});
