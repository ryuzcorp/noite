import { AdminAppsPanel } from "../admin/apps";
import { AdminInvitesPanel } from "../admin/invites";
import { AdminUsersPanel } from "../admin/users";
import { ErrorsPanel, ErrorsSummary, liveErrors } from "../app-detail/errors";
import { RuntimeLogs } from "../app-detail/logs";
import {
  DEFAULT_METRICS_HOURS,
  MetricsCard,
  MetricsRangePicker,
  toMetricsHours,
} from "../app-detail/metrics";
import { DetailShell, DetailTabs } from "../app-detail/shell";
import {
  CONTROL_APP_ID,
  CONTROL_APP_NAME,
  CONTROL_APP_SUBTITLE,
  CONTROL_BUILD,
} from "../control-app";
import { adminStatus, session } from "../resources";
//! Detail for the reserved control app (`_control`): the control plane as a
//! tenant-shaped page AND the admin home. The control fleet emits celld
//! telemetry into the same ingest as every app (reserved key `_control`, no
//! `app` row — see runner `host/control.rs`), so the Overview, Metrics, Errors
//! and Logs surfaces reuse the tenant panels unchanged. Instance
//! administration (Users, Apps, Invites) shares the page. Overview lists the
//! control D1, which opens on its own `/storage/_control/...` page like any
//! app's storage.
//!
//! Visibility mirrors the server gate: a real instance admin, never an
//! impersonated session — and the runner streams behind these panels re-check
//! the same rule (lib/server/apps.server, src/http/routes).
//!
//! The dev image serves this UI from `vite dev` and supervises no control
//! celld, so there is no control telemetry at all. The runner reports that on
//! `GET /v1/admin/stats` (`control_fleet`, read through `adminStatus()`), and
//! this page then hides the telemetry tabs (see `NEEDS_FLEET`) and shows one
//! notice instead. The admin tabs and the control D1 keep working — neither
//! depends on the fleet.
import { searchParam } from "../search-param";
import { AppStorageList } from "../storage/list";
import { Avatar } from "../ui/avatar";
import { ListSkeleton } from "../ui/skeletons";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "metrics", label: "Metrics" },
  { id: "errors", label: "Errors" },
  { id: "logs", label: "Logs" },
  { id: "users", label: "Users" },
  { id: "apps", label: "Apps" },
  { id: "invites", label: "Invites" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Telemetry tabs need the control fleet: in `make dev` there is no control
 * celld to record requests, errors or logs, so they are hidden (and a stale
 * `?t=` falls back to Overview) rather than charting data that cannot exist.
 * The admin tabs work either way. */
const NEEDS_FLEET: Record<TabId, boolean> = {
  apps: false,
  errors: true,
  invites: false,
  logs: true,
  metrics: true,
  overview: false,
  users: false,
};

/** Parse `?t=`: unknown tabs fall back to overview. */
const toTabId = (raw: string): TabId =>
  TABS.find((tab) => tab.id === raw)?.id ?? "overview";

/** Metrics tab: the window lives in `?r=` (24 / 168 / 720 hours), like a
 * tenant app. The card is keyed by the window because its live feed opens one
 * URL for the life of a component. */
const ControlMetricsTab = () => {
  const range = searchParam("r", {
    default: DEFAULT_METRICS_HOURS,
    parse: toMetricsHours,
  });
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-2">
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

/** Shaped like a tenant app's header: avatar, name, then one line of facts. */
const Header = ({ controlFleet }: { controlFleet: boolean }) => (
  <header class="flex min-w-0 items-center gap-3">
    <Avatar class="shrink-0" label={CONTROL_APP_NAME} size="lg" />
    <div class="min-w-0">
      <h1 class="m-0 truncate text-xl font-semibold">{CONTROL_APP_NAME}</h1>
      <p class="m-0 flex flex-wrap items-center gap-x-2 text-sm">
        <span class="badge badge-sm">{CONTROL_APP_SUBTITLE}</span>
        <span class="opacity-70">
          build <span class="font-mono">{CONTROL_BUILD}</span>
        </span>
        {/* The control plane's numbers include this dashboard's own traffic:
            every page load polls and its logs/errors streams stay open. Only
            shown where the telemetry tabs exist. */}
        {controlFleet ? (
          <span class="opacity-70">
            · telemetry includes this dashboard's own polling and streams
          </span>
        ) : null}
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

const ControlAppDetailBody = ({
  controlFleet,
  email,
}: {
  controlFleet: boolean;
  email: string;
}) => {
  const tab = searchParam<TabId>("t", { default: "overview", parse: toTabId });
  const requested = tab();
  // A stale `?t=metrics` on an install without the control fleet falls back
  // to Overview rather than rendering an empty panel.
  const active =
    controlFleet || !NEEDS_FLEET[requested] ? requested : "overview";
  const tabs = controlFleet
    ? TABS
    : TABS.filter((item) => !NEEDS_FLEET[item.id]);
  // The open error (ErrorsPanel's `?e=`) lives in the URL too: a tab click
  // lands on the tab's top level, so Errors shows the list, not a stale
  // detail. Same live feed as the Errors tab, so the badge never lags it.
  const openError = searchParam("e", { default: "" });
  const openErrors = controlFleet
    ? (liveErrors(CONTROL_APP_ID, "open").data()?.counts.open ?? 0)
    : 0;
  return (
    <DetailShell
      panel={null}
      header={
        <>
          <Header controlFleet={controlFleet} />
          <DetailTabs
            active={active}
            counts={{ errors: openErrors }}
            tabs={tabs}
            onSelect={(next) => {
              openError.set("");
              tab.set(toTabId(next));
            }}
          />
        </>
      }
    >
      {active === "overview" && controlFleet ? (
        <>
          <MetricsCard
            appId={CONTROL_APP_ID}
            viewAllHref={`/apps/${CONTROL_APP_ID}?t=metrics`}
          />
          <ErrorsSummary appId={CONTROL_APP_ID} />
        </>
      ) : null}
      {active === "overview" && !controlFleet ? <NoControlFleetNotice /> : null}
      {active === "overview" ? <AppStorageList appId={CONTROL_APP_ID} /> : null}
      {active === "metrics" ? <ControlMetricsTab /> : null}
      {active === "errors" ? (
        <ErrorsPanel appId={CONTROL_APP_ID} canTriage />
      ) : null}
      {active === "logs" ? <RuntimeLogs appId={CONTROL_APP_ID} /> : null}
      {/* Admin panels keep their searches in the URL (`uq`/`up`, `aq`, `iq` —
          none collide with the control page's `t`/`e`/`r`). */}
      {active === "users" ? <AdminUsersPanel email={email} /> : null}
      {active === "apps" ? <AdminAppsPanel /> : null}
      {active === "invites" ? <AdminInvitesPanel /> : null}
    </DetailShell>
  );
};

export const ControlAppDetail = () => {
  // Both resources are cached by key (`session()` is shared with the layout,
  // `adminStatus()` with /apps). The tab body is a separate component: its
  // hooks run only once the gate has admitted the viewer.
  const admin = adminStatus();
  const sess = session();
  const ready = admin.data() !== undefined && sess.data() !== undefined;
  const allowed =
    (admin.data()?.isAdmin ?? false) &&
    sess.data()?.session.impersonatedBy === null;
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
  // `controlFleet` is false only when the runner says it supervises no
  // control fleet (the dev image: vite dev serves the UI) — then there is no
  // telemetry to chart and the body hides those tabs. Unknown/loading (the
  // runner could not answer) reads as managed: a healthy release install
  // must never show the dev notice.
  return (
    <ControlAppDetailBody
      controlFleet={admin.data()?.controlFleet !== false}
      email={sess.data()?.user.email ?? ""}
    />
  );
};
