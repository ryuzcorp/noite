import { DeployList, DeployDropdown } from "$lib/app-detail/deploys";
import { EventsPanel } from "$lib/app-detail/events";
import { CODE_SVG } from "$lib/app-detail/icons";
import { MetricsCard } from "$lib/app-detail/metrics";
import { AppDetailPanel } from "$lib/app-detail/panel";
import { AppSettingsPanel } from "$lib/app-detail/settings";
import { get } from "$lib/apps.server";
import { batched } from "$lib/batched-loads";
import { useRoute, head, navigate } from "@ilha/router";
import { unsafe, watch } from "ilha";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "deployments", label: "Deployments" },
  { id: "metrics", label: "Metrics" },
  { id: "events", label: "Events" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AppPage() {
  const route = useRoute();
  const appId = route.params().id;
  head({ title: "App · Noite" });

  // Active tab lives in ?t= so refresh restores it; unknown values fall
  // back to overview.
  const activeTab = (): TabId => {
    const t = new URLSearchParams(route.search()).get("t");
    return TABS.find((tab) => tab.id === t)?.id ?? "overview";
  };
  const selectTab = (tab: TabId) => {
    navigate(`${route.path()}?t=${tab}`, { replace: true });
  };

  // Tab title follows the app once loaded (head() only applies on mount).
  watch.once(() => {
    if (!appId) {
      return;
    }
    void (async () => {
      try {
        const info = await batched(() => get(appId));
        if (typeof document !== "undefined") {
          document.title = `${info.app.name} · Noite`;
        }
      } catch {
        // keep the default title
      }
    })();
  });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div class="flex items-center justify-between gap-2">
        <div role="tablist" class="tabs tabs-border w-fit">
          {TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab() === tab.id ? "true" : "false"}
              class={`tab ${activeTab() === tab.id ? "tab-active" : ""}`}
              onclick={() => {
                selectTab(tab.id);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {appId ? (
          <div class="flex shrink-0 items-center gap-2">
            <a href={`/apps/${appId}/source`} class="btn btn-sm">
              <span class="inline-flex items-center gap-1">
                {unsafe(CODE_SVG)}
                Code
              </span>
            </a>
            <DeployDropdown appId={appId} />
          </div>
        ) : null}
      </div>

      {activeTab() === "overview" ? <AppDetailPanel /> : null}
      {activeTab() === "deployments" ? (
        <>
          {appId ? (
            <DeployList appId={appId} />
          ) : (
            <p class="m-0 text-sm opacity-70">Missing app id.</p>
          )}
        </>
      ) : null}
      {activeTab() === "metrics" ? (
        <>
          {appId ? (
            <MetricsCard appId={appId} detail />
          ) : (
            <p class="m-0 text-sm opacity-70">Missing app id.</p>
          )}
        </>
      ) : null}
      {activeTab() === "events" ? (
        <>
          {appId ? (
            <EventsPanel appId={appId} />
          ) : (
            <p class="m-0 text-sm opacity-70">Missing app id.</p>
          )}
        </>
      ) : null}
      {activeTab() === "settings" ? <AppSettingsPanel /> : null}
    </div>
  );
}
