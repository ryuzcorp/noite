import "@fontsource-variable/geist";
import { SidebarApps, sidebarPlace } from "$lib/apps/sidebar";
import "@fontsource-variable/geist-mono";

import "../app.css";
import { AppStateSyncSlot } from "$lib/apps/state-sync";
import { authClient } from "$lib/auth-client";
import { Authed } from "$lib/auth/authed";
import { Onboarding } from "$lib/auth/onboarding";
import { invalidateSession } from "$lib/auth/session";
import { CONTROL_APP_ID } from "$lib/control-app";
import { session } from "$lib/resources";
import { provideQueryCell } from "$lib/search-param";
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
import { UpdateBanner } from "$lib/update/banner";
import { Link, useLink, useRouter } from "@ilha/void";
import { atom, watch } from "ilha";
import type { View } from "ilha";

import { resourceValue } from "../lib/resource";

/**
 * Global chrome for the dashboard. Excludes the auth page so /login stays
 * bare — the session gate wraps the ENTIRE chrome (nav included), so a
 * logged-out visitor never sees dashboard pixels, not even the sidebar.
 */

/** daisyUI dropdown wiring (the old generated-entry module `src/client.ts`;
 * Void generates the client entry now, so the layout owns it — the layout
 * stays mounted across navigations, exactly like the old entry did). */
// daisyUI dropdowns are open while focus is inside them. Router
// navigation keeps focus on the clicked item, so the menu would stay
// open after "Account". Blurring on an item click closes every dropdown
// the same way; a card-style dropdown's own controls (e.g. a copy
// button) keep it open.
const onDropdownClick = (event: MouseEvent) => {
  const item =
    event.target instanceof Element
      ? event.target.closest(
          ".dropdown-content a[href], .dropdown-content.menu button"
        )
      : null;

  if (item && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
};

// `<details class="dropdown">` popovers (filters, sort, menus) only close
// when their own summary is clicked. Close every open one on a press
// outside it, which also means opening one dropdown closes the others.
const closeOpenDetails = (except?: Node) => {
  for (const open of document.querySelectorAll<HTMLDetailsElement>(
    "details.dropdown[open]"
  )) {
    if (!(except && open.contains(except))) {
      open.open = false;
    }
  }
};

const onDropdownPointerDown = (event: PointerEvent) => {
  closeOpenDetails(event.target instanceof Node ? event.target : undefined);
};

/** The phone drawer's checkbox: daisyUI's one source of truth for whether
 * the drawer is open. At `lg` and up the drawer is always open (`drawer-open`
 * wins) and the state is left alone. */
const drawerToggle = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>("#nav-drawer");

/** The top bar's toggle, which opens the drawer and gets focus back when Esc
 * closes it. */
const DRAWER_TOGGLE = "[data-drawer-toggle]";

/** Close the phone drawer if it is open; answers whether it was. */
const closeDrawer = (): boolean => {
  const toggle = drawerToggle();

  if (toggle?.checked !== true) {
    return false;
  }

  toggle.checked = false;

  return true;
};

// Esc closes the popovers first (an open `<details>` one, or the focus-based
// account menu by dropping focus out of it) and the phone drawer second, so
// one press never closes two layers at once. Only the press that closes the
// drawer hands focus back to the toggle: the drawer's items are gone with it,
// and a keyboard user must not be left on a hidden element. A dialog's own
// Esc handling is unaffected.
const onShellKeyDown = (event: KeyboardEvent) => {
  if (event.key !== "Escape") {
    return;
  }

  const openDetails = document.querySelector("details.dropdown[open]");
  const active = document.activeElement;
  const focused = active instanceof HTMLElement ? active : null;
  const inMenu = focused !== null && focused.closest(".dropdown") !== null;

  if (openDetails || inMenu) {
    closeOpenDetails();

    if (inMenu) {
      focused.blur();
    }

    return;
  }

  if (closeDrawer()) {
    document.querySelector<HTMLElement>(DRAWER_TOGGLE)?.focus();
  }
};

// A tap on any destination inside the drawer closes it, so the next page is
// never hidden behind an open overlay. The account row is the one item that
// does not navigate — it opens the profile menu, which closes on its own
// items' clicks (they are links and buttons too).
const onDrawerItemClick = (event: MouseEvent) => {
  const { target } = event;

  if (
    target instanceof Element &&
    target.closest(".drawer-side a[href], .drawer-side button") !== null
  ) {
    closeDrawer();
  }
};

/** The shell's document-level wiring: dropdowns and the phone drawer. The
 * layout stays mounted across navigations, so this runs once. */
const useShellWiring = (): void => {
  watch.once(({ onCleanup }) => {
    if (typeof document === "undefined") {
      return;
    }

    document.addEventListener("click", onDropdownClick);
    document.addEventListener("click", onDrawerItemClick);
    document.addEventListener("pointerdown", onDropdownPointerDown);
    document.addEventListener("keydown", onShellKeyDown);
    onCleanup(() => {
      document.removeEventListener("click", onDropdownClick);
      document.removeEventListener("click", onDrawerItemClick);
      document.removeEventListener("pointerdown", onDropdownPointerDown);
      document.removeEventListener("keydown", onShellKeyDown);
    });
  });
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

export default function DashboardLayout({ children }: { children?: View }) {
  // The cell every `searchParam` read subscribes to (see $lib/search-param).
  // It must run on every render, before the /login early return.
  provideQueryCell();
  useShellWiring();

  // The chrome's own state, like the cell above: the sidebar is part of the
  // shell, so it is created before the /login early return — nothing binds
  // there, because the drawer is not rendered.
  // The group holds functions and DOM state: it cannot cross the SSR
  // snapshot (functions do not serialize), so it stays out of it and the
  // client builds its own on hydration.
  const sidebar = atom.lazy(() => createPaneGroup(SIDEBAR_PANES), {
    snapshot: false,
  })();

  watch.once(({ onCleanup }) => {
    onCleanup(() => {
      sidebar.destroy();
    });
  });
  const router = useRouter();
  // Native `<a>`s below: the Apps and Account items sit as `li > a` under
  // daisyUI `menu` CSS (child combinators), where a `Link` host span would
  // break the item styling.
  const link = useLink();

  const signOut = async () => {
    // Sign out first: invalidating before the cookie is gone refetched (and
    // re-cached) the outgoing user's session.
    await authClient.signOut();
    invalidateSession();
    await router.visit("/login");
  };

  const { activeAppId, activeView, onAppsPages } = sidebarPlace(router.path);
  const appsItemActive = onAppsPages && activeAppId === null;
  const sessionRes = session();
  const user = resourceValue(sessionRes.state())?.user;
  const displayName = user?.name || user?.email || "";

  if (router.path === "/login") {
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
            <Link
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
            </Link>
            <ul class="menu w-full flex-1">
              {/* The phone drawer's top bar sits right above this list, so
                  the first item needs its own breathing room there; at `lg`
                  the menu-title already spaces it. */}
              <li class="mt-2 lg:mt-0">
                <a
                  {...link("/apps")}
                  data-tour="apps"
                  class={appsItemActive ? "menu-active" : undefined}
                  aria-current={appsItemActive ? "page" : undefined}
                >
                  <ListIcon class="h-5 w-5 shrink-0" />
                  Apps
                </a>
                {/* Always mounted: the app list is the shell's navigation, not
                    a submenu of /apps. It reads the same live feed as the
                    /apps page (one SSE topic, one connection — see
                    $lib/feeds), and `sidebarPlace` highlights the open app's
                    page from the URL. */}
                <SidebarApps activeId={activeAppId} activeView={activeView} />
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
                    <a {...link("/account")}>
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
        {/* The page column is one stacking context below `lg`, so nothing it
            renders can paint over the open phone drawer: pages carry their
            own `z-*` chrome (the sticky top bar at `z-40`, a sticky tab row at
            `z-10`, and the app header's Deploy dropdown at `z-50`), and any
            of those would otherwise win by DOM order against daisyUI's
            `z-10` drawer. An `isolate` context keeps every one of them inside
            the column, where the drawer simply covers it. At `lg` the sidebar
            is a pane beside the column, nothing overlaps, and the split's
            handle keeps its own stacking. Native `<dialog>` modals use
            `showModal()` (the top layer), so they stay above all of this. */}
        <div
          class="drawer-content bg-base-200 dark:bg-base-100 flex min-h-screen flex-1 flex-col max-lg:isolate"
          data-slot="resizable-panel"
          data-default-size={sidebarSplit?.[1]}
          data-morph-preserve={MORPH_PRESERVE}
        >
          {/* Phones: a real top bar instead of a floating button, so the
              menu toggle never sits on top of page content. */}
          <div class="bg-base-200/90 dark:bg-base-100/90 border-base-300 sticky top-0 z-40 flex items-center gap-2 border-b px-2 py-2 backdrop-blur lg:hidden">
            {/* A real button, not a `label for` the checkbox: the phone drawer
                is a disclosure a keyboard user must be able to open, and Esc
                hands focus back to this control by name (see onShellKeyDown). */}
            <button
              type="button"
              class="btn btn-sm btn-ghost btn-square"
              aria-label="Open menu"
              aria-controls="nav-drawer"
              data-drawer-toggle
              onclick={() => {
                const toggle = drawerToggle();

                if (toggle !== null) {
                  toggle.checked = true;
                }
              }}
            >
              <MenuIcon class="h-5 w-5" />
            </button>
            <Link href="/apps" class="inline-flex" aria-label="Noite dashboard">
              <img src="/logo.svg" alt="" class="h-5 w-auto dark:hidden" />
              <img
                src="/logo-dark.svg"
                alt=""
                class="hidden h-5 w-auto dark:block"
              />
            </Link>
          </div>
          <UpdateBanner />
          {children}
        </div>
      </div>
      {/* The open app's status badges follow its state stream (see
          $lib/apps/state-sync); the control plane has its own page. */}
      {activeAppId !== null && activeAppId !== CONTROL_APP_ID ? (
        <AppStateSyncSlot appId={activeAppId} />
      ) : null}
      <Onboarding />
    </Authed>
  );
}
