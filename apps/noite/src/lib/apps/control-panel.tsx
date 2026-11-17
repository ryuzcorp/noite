import { Link, useRouter } from "@ilha/void";
import { watch } from "ilha";

import { AdminAppsPanel } from "../admin/apps";
import { AdminSettingsPanel } from "../admin/settings";
import { AdminUsersPanel } from "../admin/users";
import { fleetState, telemetryAvailable } from "../app-detail/control-fleet";
import type { FleetState } from "../app-detail/control-fleet";
import { ErrorsPanel, ErrorsSummary, liveErrors } from "../app-detail/errors";
import { RuntimeLogs } from "../app-detail/logs";
import {
  AnalyticsCard,
  DEFAULT_METRICS_HOURS,
  MetricsCard,
  MetricsRangePicker,
  toMetricsHours,
} from "../app-detail/metrics";
import { DetailShell, DetailTabs } from "../app-detail/shell";
import { mayAdministerInstance, overviewAuthority } from "../authority";
import {
  CONTROL_APP_ID,
  CONTROL_APP_NAME,
  CONTROL_APP_SUBTITLE,
} from "../control-app";
import { resourceValue } from "../resource";
import { adminStatus, session, updateStatus } from "../resources";
//! Detail for the reserved control app (`_control`): the control plane as a
//! tenant-shaped page AND the admin home. The control fleet emits celld
//! telemetry into the same ingest as every app (reserved key `_control`, no
//! `app` row — see runner `host/control.rs`), so the Overview, Metrics,
//! Analytics, Errors and Logs surfaces reuse the tenant panels unchanged.
//! Instance administration shares the page as one Admin tab: the Users
//! section (every account — search, pages of 25, role, ban, delete,
//! impersonate; email invitations; pending approvals), the Apps section (all
//! owners: start/stop/delete), and the instance-wide switches (anonymous
//! telemetry, the release check, the registration waitlist).
//! Overview lists the control D1, which opens on its own
//! `/storage/_control/...` page like any app's storage.
//!
//! Visibility mirrors the server gate: only a real instance admin reaches
//! this page, never while impersonating — any other signed-in account is
//! redirected to `/account`, which owns the Account surface again (stale
//! `?t=account` bookmarks redirect too). The runner streams and admin
//! actions behind the panels re-check the same rule server-side
//! (lib/server/apps.server, src/http/routes), so the redirect is navigation,
//! not the gate.
//!
//! The dev image serves this UI from `vite dev` and supervises no control
//! celld, so there is no control telemetry at all. The runner reports that on
//! `GET /v1/admin/stats` (`control_fleet`, read through `adminStatus()`), and
//! this page then hides the telemetry tabs (see `NEEDS_FLEET`) and shows one
//! notice instead. The Admin tab and the control D1 keep working — neither
//! depends on the fleet.
import { searchParam } from "../search-param";
import { AppStorageList } from "../storage/list";
import { Avatar } from "../ui/avatar";
import { ListSkeleton } from "../ui/skeletons";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "metrics", label: "Metrics" },
  { id: "analytics", label: "Analytics" },
  { id: "errors", label: "Errors" },
  { id: "logs", label: "Logs" },
  { id: "admin", label: "Admin" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Everything `?t=` can resolve to: a tab, or the retired Account tab (which
 * lives at `/account` again — the page redirects there, old bookmarks
 * included). */
export type ControlRoute = TabId | "account";

/** Telemetry tabs need the control fleet: in `make dev` there is no control
 * celld to record requests, errors or logs, so they are hidden (and a stale
 * `?t=` falls back to Overview) rather than charting data that cannot exist.
 * The Admin tab works either way. */
const NEEDS_FLEET: Record<TabId, boolean> = {
  admin: false,
  analytics: true,
  errors: true,
  logs: true,
  metrics: true,
  overview: false,
};

/** Stale `?t=` values from before the Admin merge: each admin tab opens the
 * merged Admin tab (which keeps its sections' own searches — `uq`/`up` for
 * users, `aq` for apps). Unknown values still fall back to Overview. */
const isLegacyAdminTab = (raw: string): boolean =>
  raw === "users" || raw === "apps" || raw === "settings" || raw === "invites";

/** Parse `?t=`: the merged Admin tab, the retired Account tab, or Overview
 * for anything unknown. Exported so the unit test pins the mapping. */
export const toControlRoute = (raw: string): ControlRoute => {
  if (raw === "account") {
    return "account";
  }

  if (isLegacyAdminTab(raw)) {
    return "admin";
  }

  return TABS.find((tab) => tab.id === raw)?.id ?? "overview";
};

/** The tabs one viewer may see, in bar order: every tab the fleet allows.
 * Non-admins see none — the page redirects them to `/account` instead of
 * rendering a tab. Pure so the unit test pins the matrix. */
export const visibleControlTabs = (
  admin: boolean,
  telemetry: boolean
): readonly { readonly id: TabId; readonly label: string }[] => {
  if (!admin) {
    return [];
  }

  return TABS.filter((item) => telemetry || !NEEDS_FLEET[item.id]);
};

/** Which tab the control page shows. A non-admin lands on the `account`
 * route whatever `?t=` says — the page redirects that route to `/account`;
 * a stale telemetry `?t=` on an install without the control fleet falls
 * back to Overview rather than rendering an empty panel. Pure so the unit
 * test pins the matrix. */
export const activeControlTab = (
  admin: boolean,
  requested: ControlRoute,
  telemetry: boolean
): ControlRoute => {
  if (!admin || requested === "account") {
    return "account";
  }

  if (telemetry || !NEEDS_FLEET[requested]) {
    return requested;
  }

  return "overview";
};

/** Metrics tab: the window lives in `?r=` (24 / 168 / 720 hours), like a
 * tenant app. The card is keyed by the window because its live feed opens one
 * URL for the life of a component. The heading sits left of the picker
 * (card-title style, like Errors/Events), wrapping above it at 390 px. */
const ControlMetricsTab = () => {
  const range = searchParam("r", {
    default: DEFAULT_METRICS_HOURS,
    parse: toMetricsHours,
  });

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="m-0 text-lg font-semibold">Metrics</h2>
        <MetricsRangePicker
          hours={range()}
          onPick={(next) => {
            range.set(next);
          }}
        />
      </div>
      <MetricsCard
        key={range()}
        appId={CONTROL_APP_ID}
        detail
        hours={range()}
      />
    </div>
  );
};

/** Analytics tab: the same `?r=` window as Metrics (switching tabs keeps the
 * window), one card per breakdown. Shares the metrics snapshot — no new
 * endpoint — through the exported `AnalyticsCard`. Same heading row as
 * Metrics: the title left, the picker right, wrapping sanely at 390 px. */
const ControlAnalyticsTab = () => {
  const range = searchParam("r", {
    default: DEFAULT_METRICS_HOURS,
    parse: toMetricsHours,
  });

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="m-0 text-lg font-semibold">Analytics</h2>
        <MetricsRangePicker
          hours={range()}
          onPick={(next) => {
            range.set(next);
          }}
        />
      </div>
      <AnalyticsCard key={range()} appId={CONTROL_APP_ID} hours={range()} />
    </div>
  );
};

/** Header text for the running Noite version (`NOITE_BUILD_VERSION` through
 * the admin-only update status: `dev` for a source checkout, the bare tag
 * otherwise). Null while the status loads (or when it answers empty), so the
 * tag stays out rather than guessing. Pure so the unit test pins it. */
export const versionLabel = (current: string | undefined): string | null => {
  if (current === undefined || current === "") {
    return null;
  }

  if (current === "dev" || current.startsWith("v")) {
    return current;
  }

  return `v${current}`;
};

/** The running Noite version through the admin-only update status. Only
 * admins reach this page, so the gate that status re-checks server-side is
 * already met. */
const VersionTag = () => {
  const label = versionLabel(resourceValue(updateStatus().state())?.current);

  if (label === null) {
    return null;
  }

  return <span class="font-mono whitespace-nowrap opacity-70">{label}</span>;
};

/** Shaped like a tenant app's header: avatar, name, then one line of facts.
 * The facts are flex chunks separated by the row's gap, never by literal `·`
 * text: a dot between two spans belongs to neither, so at 390 px it wraps
 * onto the next line as a leading (or, at the end of the previous line,
 * dangling) separator. Each fact may wrap inside itself instead. */
const Header = () => (
  <header class="flex min-w-0 items-center gap-3">
    <Avatar class="shrink-0" label={CONTROL_APP_NAME} size="lg" />
    <div class="min-w-0">
      <h1 class="m-0 truncate text-xl font-semibold">{CONTROL_APP_NAME}</h1>
      <p class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span class="badge badge-sm">{CONTROL_APP_SUBTITLE}</span>
        <VersionTag />
      </p>
    </div>
  </header>
);

/** Overview for an install that does not supervise the control fleet: the
 * dev image serves the UI from `vite dev`, so there is no control celld and
 * therefore no telemetry to chart. The admin tabs and the control D1 still
 * work (the D1 lives in this worker's binding, not in the fleet). */
const NoControlFleetNotice = () => (
  <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
    <div class="card-body gap-2">
      <h2 class="m-0 text-lg font-semibold">
        Control-plane telemetry needs the release image
      </h2>
      <p class="m-0 text-sm opacity-70">
        In <code>make dev</code> the control UI runs under vite, not celld, so
        there is no control fleet to record requests, errors or logs. Storage
        and the admin panels still work.
      </p>
    </div>
  </section>
);

/** The runner has not answered `control_fleet` yet: neither claim it is
 * managed (telemetry tabs would hang on a stream that never opens) nor that
 * it is absent. */
const FleetUnknownNotice = () => (
  <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
    <div class="card-body gap-2">
      <h2 class="m-0 text-lg font-semibold">
        Control-plane telemetry is not available yet
      </h2>
      <p class="m-0 text-sm opacity-70">
        The runner has not reported whether it supervises the control fleet.
        Storage and the admin panels still work; telemetry tabs appear once it
        answers.
      </p>
    </div>
  </section>
);

/** One-way ticket off the control page: non-admin viewers, and stale
 * `?t=account` bookmarks from when the Account tab lived here, belong on
 * `/account` — which owns the Account surface again. Navigation only: every
 * admin API and stream behind the tabs re-checks server-side. */
const RedirectToAccount = () => {
  const router = useRouter();

  watch.once(() => {
    if (typeof window === "undefined") {
      return;
    }

    void router.visit("/account");
  });

  return (
    <div class="w-full px-4 pt-4 pb-12">
      <p class="m-0 text-sm opacity-70">
        Your account lives at{" "}
        <Link href="/account" class="link">
          /account
        </Link>{" "}
        — taking you there…
      </p>
    </div>
  );
};

const ControlAppDetailBody = ({ fleet }: { fleet: FleetState }) => {
  const tab = searchParam<ControlRoute>("t", {
    default: "overview",
    parse: toControlRoute,
  });

  const requested = tab();
  const telemetry = telemetryAvailable(fleet);
  const active = activeControlTab(true, requested, telemetry);
  const tabs = visibleControlTabs(true, telemetry);

  // The open error (ErrorsPanel's `?e=`) lives in the URL too: a tab click
  // lands on the tab's top level, so Errors shows the list, not a stale
  // detail. Same live feed as the Errors tab, so the badge never lags it.
  const openError = searchParam("e", { default: "" });

  const openErrors = telemetry
    ? (liveErrors(CONTROL_APP_ID, "open").data()?.counts.open ?? 0)
    : 0;

  // The retired Account route (`?t=account`, an old bookmark): the surface
  // lives at `/account` now.
  if (active === "account") {
    return <RedirectToAccount />;
  }

  return (
    <DetailShell
      panel={null}
      header={
        <>
          <Header />
          <DetailTabs
            active={active}
            counts={{ errors: openErrors }}
            tabs={tabs}
            onSelect={(next) => {
              openError.set("");
              tab.set(toControlRoute(next));
            }}
          />
        </>
      }
    >
      {active === "overview" && telemetry ? (
        <>
          <MetricsCard
            appId={CONTROL_APP_ID}
            viewAllHref={`/apps/${CONTROL_APP_ID}?t=metrics`}
          />
          <ErrorsSummary appId={CONTROL_APP_ID} />
        </>
      ) : null}
      {active === "overview" && fleet._tag === "Absent" ? (
        <NoControlFleetNotice />
      ) : null}
      {active === "overview" && fleet._tag === "Unknown" ? (
        <FleetUnknownNotice />
      ) : null}
      {active === "overview" ? <AppStorageList appId={CONTROL_APP_ID} /> : null}
      {active === "metrics" ? <ControlMetricsTab /> : null}
      {active === "analytics" ? <ControlAnalyticsTab /> : null}
      {active === "errors" ? (
        <ErrorsPanel appId={CONTROL_APP_ID} canTriage />
      ) : null}
      {/* The Logs tab in the standard card (title row like the Errors/Events
          cards, same component and classes). The tail itself stays the shared
          `RuntimeLogs`: the deploy rows mount it bare inside the Deployments
          list, so the card lives here, not in it. */}
      {active === "logs" ? (
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="m-0 text-lg font-semibold">Logs</h2>
            </div>
            <RuntimeLogs appId={CONTROL_APP_ID} />
          </div>
        </section>
      ) : null}
      {/* One Admin tab, three stacked sections with their own headings. The
          admin panels keep their searches in the URL (`uq`/`up`, `aq` — none
          collide with the control page's `t`/`e`/`r`). */}
      {active === "admin" ? (
        <div class="flex flex-col gap-4">
          <AdminUsersPanel />
          <AdminAppsPanel />
          <AdminSettingsPanel />
        </div>
      ) : null}
    </DetailShell>
  );
};

export const ControlAppDetail = () => {
  // Both resources are cached by key (`session()` is shared with the layout,
  // `adminStatus()` with /apps). The tab body is a separate component: its
  // hooks run only once the gate has admitted the viewer.
  const admin = adminStatus();
  const sess = session();

  const ready =
    resourceValue(admin.state()) !== undefined &&
    resourceValue(sess.state()) !== undefined;

  // The one predicate (lib/authority): role, env anchor, ban and
  // impersonation are already folded in by the server's overview. Admins get
  // every tab; any other signed-in account is redirected to `/account`,
  // which owns the Account surface again — banned, anonymous, impersonated
  // and pending sessions keep the old answer. Every admin panel and control
  // stream re-checks server-side, so the redirect is navigation, not the
  // gate.
  const authority = overviewAuthority(resourceValue(admin.state()));
  const isAdmin = mayAdministerInstance(authority);
  const allowed = isAdmin || authority._tag === "Plain";

  if (!ready) {
    return (
      <div class="w-full px-4 pt-4 pb-12">
        <ListSkeleton rows={3} />
      </div>
    );
  }

  if (!allowed) {
    return (
      <div class="w-full px-4 pt-4 pb-12">
        <p class="m-0 text-sm opacity-70">App not found.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return <RedirectToAccount />;
  }

  // Three states, never two: `Managed` shows telemetry, `Absent` (the dev
  // image: vite dev serves the UI) shows the dev notice, and `Unknown` (the
  // runner has not answered) shows a neutral notice rather than guessing.
  return (
    <ControlAppDetailBody
      fleet={fleetState(resourceValue(admin.state())?.controlFleet)}
    />
  );
};
