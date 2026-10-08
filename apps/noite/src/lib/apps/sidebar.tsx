/** The sidebar's app list: the children of the Apps item while the user is
 * on the apps pages, with the open app's own App, Code and Pulls items under
 * it. Live over the same stream as the /apps list, so a new, renamed or
 * deleted app shows up without a reload. Its own component, so a stream
 * frame re-renders only this list, never the page beside it. */
import type { View } from "ilha";

import { CONTROL_APP_ID, CONTROL_APP_NAME } from "../control-app";
import { applistUrl, decodeApps, feedKeys, liveFeed } from "../feeds";
import { OpenPrBadge } from "../prs/layout";
import { adminStatus, session } from "../resources";
import { Code, GitPullRequest, LayoutDashboard } from "../ui/icons";
import { presenceTone } from "./identity";

/** Which part of the open app a page belongs to: Code mode (`/source…`),
 * the pulls (`/pulls…`) or everything else (overview tabs, storage
 * editors). */
export type AppView = "app" | "code" | "pulls";

/** `/apps/<id>/<sub>` pages that are not the App view. */
const SUB_VIEWS = {
  pulls: "pulls",
  source: "code",
} as const satisfies Record<string, AppView>;

/** Own keys only: `sub` comes from the URL (`/apps/x/constructor`). */
const isSubView = (sub: string): sub is keyof typeof SUB_VIEWS =>
  Object.hasOwn(SUB_VIEWS, sub);

/** The sidebar's position: inside the apps pages (where the app list shows)
 * at all, on which app, and in which part of it. */
export interface SidebarPlace {
  activeAppId: string | null;
  activeView: AppView | null;
  onAppsPages: boolean;
}

/** Where the sidebar stands for `path`. An app's own pages (`/apps/<id>/…`,
 * and its storage editors under `/storage/<id>/…`) select that app; the list
 * and `/apps/new` select none, which leaves the Apps item itself active. */
export const sidebarPlace = (path: string): SidebarPlace => {
  const [section = "", segment = "", sub = ""] = path.split("/").slice(1);
  const onAppsPages = section === "apps" || section === "storage";
  const isAppPage =
    onAppsPages && segment !== "" && !(section === "apps" && segment === "new");
  if (!isAppPage) {
    return { activeAppId: null, activeView: null, onAppsPages };
  }
  return {
    activeAppId: decodeURIComponent(segment),
    activeView: section === "apps" && isSubView(sub) ? SUB_VIEWS[sub] : "app",
    onAppsPages,
  };
};

const MenuLink = ({
  active,
  children,
  href,
}: {
  active: boolean;
  children: View;
  href: string;
}) => (
  <li>
    <a
      href={href}
      class={`gap-2 ${active ? "menu-active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </a>
  </li>
);

/** One app. The open app (`view` set) expands into App, Code and Pulls, and
 * the highlight moves to whichever the page is in; the Noite admin home has
 * neither Code mode nor pulls, so it stays a single highlighted row. */
const SidebarAppLink = ({
  appId,
  name,
  status,
  view,
}: {
  appId: string;
  name: string;
  status: string;
  view: AppView | null;
}) => {
  const href = `/apps/${appId}`;
  const expanded = view !== null && appId !== CONTROL_APP_ID;
  return (
    <li>
      <a
        href={href}
        class={`gap-2 ${view !== null && !expanded ? "menu-active" : ""}`}
        aria-current={view !== null && !expanded ? "page" : undefined}
      >
        {/* Icon-sized slot (the Apps item's h-5 w-5 icon), so app names line
            up with "Apps". */}
        <span class="flex h-5 w-5 shrink-0 items-center justify-center">
          <span
            class={`status ${presenceTone(status)}`}
            title={status}
            aria-hidden="true"
          />
        </span>
        <span class="truncate">{name}</span>
      </a>
      {expanded ? (
        <ul aria-label={name}>
          <MenuLink active={view === "app"} href={href}>
            <LayoutDashboard class="shrink-0" />
            App
          </MenuLink>
          <MenuLink active={view === "code"} href={`${href}/source`}>
            <Code class="shrink-0" />
            Code
          </MenuLink>
          <MenuLink active={view === "pulls"} href={`${href}/pulls`}>
            <GitPullRequest class="shrink-0" />
            Pulls
            <OpenPrBadge appId={appId} class="ms-auto" />
          </MenuLink>
        </ul>
      ) : null}
    </li>
  );
};

export const SidebarApps = ({
  activeId,
  activeView,
}: {
  activeId: string | null;
  activeView: AppView | null;
}) => {
  const feed = liveFeed(feedKeys.apps, applistUrl(), decodeApps);
  const user = session().data();
  // The control plane is listed for instance admins, never while
  // impersonating — the same rule as its card on /apps.
  const showControl =
    user !== undefined &&
    user !== null &&
    (adminStatus().data()?.isAdmin ?? false);
  const apps = feed.latest() ?? [];
  if (!showControl && apps.length === 0) {
    return null;
  }
  return (
    // Flush with Apps: no nested-menu indent or guide line.
    <ul aria-label="Your apps" class="ms-0 ps-0 before:hidden">
      {showControl ? (
        <SidebarAppLink
          appId={CONTROL_APP_ID}
          name={CONTROL_APP_NAME}
          status="running"
          view={activeId === CONTROL_APP_ID ? activeView : null}
        />
      ) : null}
      {apps.map((app) => (
        <SidebarAppLink
          key={app.id}
          appId={app.id}
          name={app.name}
          status={app.status}
          view={activeId === app.id ? activeView : null}
        />
      ))}
    </ul>
  );
};
