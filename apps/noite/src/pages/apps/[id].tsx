import { DeployList } from "$lib/app-detail/deploys";
import { ErrorsPanel, liveErrors } from "$lib/app-detail/errors";
import { EventsPanel, liveEventCount } from "$lib/app-detail/events";
import {
  DEFAULT_METRICS_HOURS,
  MetricsCard,
  MetricsRangePicker,
  toMetricsHours,
} from "$lib/app-detail/metrics";
import { AppDetailPanel, AppHeader } from "$lib/app-detail/panel";
import { AppSettingsPanel } from "$lib/app-detail/settings/panel";
import { DetailShell, DetailTabs } from "$lib/app-detail/shell";
import { ControlAppDetail } from "$lib/apps/control-panel";
import { CONTROL_APP_NAME, isControlApp } from "$lib/control-app";
import { appDetail } from "$lib/resources";
import { searchParam } from "$lib/search-param";
import { Cog } from "$lib/ui/icons";
import { SidePanel } from "$lib/ui/side-panel";
import { useRoute, head } from "@ilha/router";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "deployments", label: "Deployments" },
  { id: "metrics", label: "Metrics" },
  { id: "errors", label: "Errors" },
  { id: "events", label: "Events" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Parse `?t=`: unknown tabs fall back to overview. */
const toTabId = (raw: string): TabId =>
  TABS.find((tab) => tab.id === raw)?.id ?? "overview";

/** The right panel beside the tabs: Settings, or closed (`""`). */
type AppPanel = "settings" | "";

/** Parse `?panel=`: anything but `settings` closes the panel. */
const toAppPanel = (raw: string): AppPanel =>
  raw === "settings" ? "settings" : "";
/** Metrics tab: the window lives in `?r=` (24 / 168 / 720 hours) so a refresh
 * or shared link keeps it. The card is keyed by the window because its live
 * feed opens one URL for the life of a component. */
const MetricsTab = ({ appId }: { appId: string }) => {
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
      <MetricsCard key={range()} appId={appId} detail hours={range()} />
    </div>
  );
};

/** Settings beside the tabs, a third of the width, like Code mode's panels. */
const SettingsAside = ({ onClose }: { onClose: () => void }) => (
  <SidePanel title="Settings" onClose={onClose}>
    <div class="min-h-0 flex-1 overflow-auto">
      <AppSettingsPanel />
    </div>
  </SidePanel>
);

const AppPageBody = ({ appId }: { appId: string }) => {
  // The reserved control app has no runner row, fleet or telemetry: it gets a
  // dedicated minimal detail instead of the tenant tabs. Branching before any
  // appDetail/liveErrors resource keeps the runner out of the loop entirely.
  if (isControlApp(appId)) {
    head({ title: `${CONTROL_APP_NAME} · Noite` });
    return <ControlAppDetail />;
  }
  const tab = searchParam<TabId>("t", { default: "overview", parse: toTabId });
  // Settings opens beside the tabs (`?panel=settings`), so it stays open
  // while they switch.
  const panel = searchParam<AppPanel>("panel", {
    default: "",
    parse: toAppPanel,
  });
  // The open error (ErrorsPanel's `?e=`): a tab click always lands on the
  // tab's top level, so the Errors tab shows the list, not a stale detail.
  const openError = searchParam("e", { default: "" });
  const name = appDetail(appId).data()?.app.name;
  head({ title: `${name ?? "App"} · Noite` });
  // Same live feeds as the Errors tab's open list and the Events tab's
  // default view, so the tab badges never lag the lists.
  const counts = {
    errors: liveErrors(appId, "open").data()?.counts.open ?? 0,
    events: liveEventCount(appId),
  };
  const settingsOpen = panel() === "settings";

  return (
    <DetailShell
      header={
        <>
          <AppHeader appId={appId} />
          <DetailTabs
            active={tab()}
            counts={counts}
            tabs={TABS}
            onSelect={(next) => {
              openError.set("");
              tab.set(toTabId(next));
            }}
            trailing={
              <button
                type="button"
                class={`btn btn-ghost btn-sm mb-1 shrink-0 ${settingsOpen ? "btn-active" : ""}`}
                aria-pressed={settingsOpen ? "true" : "false"}
                onclick={() => {
                  panel.set(settingsOpen ? "" : "settings");
                }}
              >
                <Cog />
                Settings
              </button>
            }
          />
        </>
      }
      panel={
        settingsOpen ? (
          <SettingsAside
            onClose={() => {
              panel.set("");
            }}
          />
        ) : null
      }
    >
      {tab() === "overview" ? <AppDetailPanel appId={appId} /> : null}
      {tab() === "deployments" ? <DeployList appId={appId} /> : null}
      {tab() === "metrics" ? <MetricsTab appId={appId} /> : null}
      {tab() === "errors" ? <ErrorsPanel appId={appId} /> : null}
      {tab() === "events" ? <EventsPanel appId={appId} /> : null}
    </DetailShell>
  );
};

/** Page shell: resolves the route param, then renders a body keyed by it.
 * Page components are reused across navigations, so /apps/A → /apps/B
 * would otherwise re-run the same fiber with a new id — and ilha's
 * resource()/fromEventSource() slots stay bound to the first key/URL.
 * The key makes an id change remount the whole subtree; the one-item keyed
 * list keeps a tab switch from remounting it (the id is the only prop, so
 * ilha reuses the row, and the body repaints through its own param reads). */
export default function AppPage() {
  const appId = useRoute().params().id;
  if (!appId) {
    head({ title: "App · Noite" });
    return <p class="m-0 text-sm opacity-70">Missing app id.</p>;
  }
  return [<AppPageBody key={appId} appId={appId} />];
}
