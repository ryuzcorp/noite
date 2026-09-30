import { DeployList } from "$lib/app-detail/deploys";
import { ErrorsPanel } from "$lib/app-detail/errors";
import { EventsPanel } from "$lib/app-detail/events";
import {
  DEFAULT_METRICS_HOURS,
  MetricsCard,
  MetricsRangePicker,
  toMetricsHours,
} from "$lib/app-detail/metrics";
import { AppDetailPanel, AppHeader } from "$lib/app-detail/panel";
import { AppSettingsPanel } from "$lib/app-detail/settings";
import { appDetail, errorList } from "$lib/resources";
import { useRoute, head, searchParam } from "@ilha/router";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "deployments", label: "Deployments" },
  { id: "metrics", label: "Metrics" },
  { id: "errors", label: "Errors" },
  { id: "events", label: "Events" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Parse `?t=`: unknown tabs fall back to overview. */
const toTabId = (raw: string): TabId =>
  TABS.find((tab) => tab.id === raw)?.id ?? "overview";

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

const AppPageBody = ({ appId }: { appId: string }) => {
  const tab = searchParam<TabId>("t", { default: "overview", parse: toTabId });
  // The open error (ErrorsPanel's `?e=`): a tab click always lands on the
  // tab's top level, so the Errors tab shows the list, not a stale detail.
  const openError = searchParam("e", { default: "" });
  const name = appDetail(appId).data()?.app.name;
  head({ title: `${name ?? "App"} · Noite` });
  // Same resource as the Errors tab's open list: the tab label shows how
  // many errors wait for triage without a second fetch.
  const openErrors = errorList(appId, "open").data()?.counts.open ?? 0;

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <AppHeader appId={appId} />
      {/* One row on every width: narrow screens scroll the tabs sideways
          instead of wrapping them into a stack. */}
      <div class="border-base-300 overflow-x-auto border-b">
        <div role="tablist" class="tabs tabs-border w-max flex-nowrap">
          {TABS.map((t) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === t.id ? "true" : "false"}
              class={`tab gap-1.5 whitespace-nowrap ${tab() === t.id ? "tab-active" : ""}`}
              onclick={() => {
                openError.set("");
                tab.set(t.id);
              }}
            >
              {t.label}
              {t.id === "errors" && openErrors > 0 ? (
                <span class="badge badge-sm tabular-nums">{openErrors}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {tab() === "overview" ? <AppDetailPanel appId={appId} /> : null}
      {tab() === "deployments" ? <DeployList appId={appId} /> : null}
      {tab() === "metrics" ? <MetricsTab appId={appId} /> : null}
      {tab() === "errors" ? <ErrorsPanel appId={appId} /> : null}
      {tab() === "events" ? <EventsPanel appId={appId} /> : null}
      {tab() === "settings" ? <AppSettingsPanel /> : null}
    </div>
  );
};

/** Page shell: resolves the route param, then renders a body keyed by it.
 * Page components are reused across navigations, so /apps/A → /apps/B
 * would otherwise re-run the same fiber with a new id — and ilha's
 * resource()/fromEventSource() slots stay bound to the first key/URL.
 * The key makes an id change remount the whole subtree instead. */
export default function AppPage() {
  const appId = useRoute().params().id;
  if (!appId) {
    head({ title: "App · Noite" });
    return <p class="m-0 text-sm opacity-70">Missing app id.</p>;
  }
  return <AppPageBody key={appId} appId={appId} />;
}
