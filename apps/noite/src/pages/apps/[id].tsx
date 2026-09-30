import { DeployList, DeployDropdown } from "$lib/app-detail/deploys";
import { EventsPanel } from "$lib/app-detail/events";
import {
  DEFAULT_METRICS_HOURS,
  MetricsCard,
  MetricsRangePicker,
  toMetricsHours,
} from "$lib/app-detail/metrics";
import { AppDetailPanel } from "$lib/app-detail/panel";
import { AppSettingsPanel } from "$lib/app-detail/settings";
import { Code } from "$lib/icons";
import { appDetail } from "$lib/resources";
import { useRoute, head, searchParam } from "@ilha/router";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "deployments", label: "Deployments" },
  { id: "metrics", label: "Metrics" },
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
  const name = appDetail(appId).data()?.app.name;
  head({ title: `${name ?? "App"} · Noite` });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div class="flex items-center justify-between gap-2">
        <div role="tablist" class="tabs tabs-border w-fit">
          {TABS.map((t) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === t.id ? "true" : "false"}
              class={`tab ${tab() === t.id ? "tab-active" : ""}`}
              onclick={() => {
                tab.set(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <a href={`/apps/${appId}/source`} class="btn btn-sm">
            <span class="inline-flex items-center gap-1">
              <Code />
              Code
            </span>
          </a>
          <DeployDropdown appId={appId} />
        </div>
      </div>

      {tab() === "overview" ? <AppDetailPanel /> : null}
      {tab() === "deployments" ? <DeployList appId={appId} /> : null}
      {tab() === "metrics" ? <MetricsTab appId={appId} /> : null}
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
