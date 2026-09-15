import {
  AppBreadcrumbs,
  AppDetailPanel,
  AppSettingsPanel,
  DeployList,
  RuntimeLogs,
} from "$lib/app-detail";
import { get } from "$lib/apps.server";
import { SourceBrowser } from "$lib/source-browser";
import { AppStorageList } from "$lib/storage";
import { useRoute, head, navigate } from "@ilha/router";
import { watch } from "ilha";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "deployments", label: "Deployments" },
  { id: "resources", label: "Resources" },
  { id: "source", label: "Source" },
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
        const info = await get(appId);
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
      {appId ? <AppBreadcrumbs appId={appId} /> : null}
      <div role="tablist" class="tabs tabs-border w-fit">
        {TABS.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab() === tab.id}
            class={`tab ${activeTab() === tab.id ? "tab-active" : ""}`}
            onclick={() => {
              selectTab(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab() === "overview" ? (
        <div class="card bg-base-100 w-full shadow">
          <div class="card-body gap-4">
            <AppDetailPanel />
          </div>
        </div>
      ) : null}
      {activeTab() === "logs" ? (
        <div class="card bg-base-100 w-full shadow">
          <div class="card-body gap-4">
            {appId ? (
              <RuntimeLogs appId={appId} />
            ) : (
              <p class="m-0 text-sm opacity-70">Missing app id.</p>
            )}
          </div>
        </div>
      ) : null}
      {activeTab() === "deployments" ? (
        <div class="card bg-base-100 w-full shadow">
          <div class="card-body gap-4">
            {appId ? (
              <DeployList appId={appId} />
            ) : (
              <p class="m-0 text-sm opacity-70">Missing app id.</p>
            )}
          </div>
        </div>
      ) : null}
      {activeTab() === "resources" ? (
        <div class="card bg-base-100 w-full shadow">
          <div class="card-body gap-4">
            {appId ? (
              <AppStorageList appId={appId} />
            ) : (
              <p class="m-0 text-sm opacity-70">Missing app id.</p>
            )}
          </div>
        </div>
      ) : null}
      {activeTab() === "source" ? (
        <div class="card bg-base-100 w-full shadow">
          <div class="card-body gap-4">
            {appId ? (
              <SourceBrowser appId={appId} />
            ) : (
              <p class="m-0 text-sm opacity-70">Missing app id.</p>
            )}
          </div>
        </div>
      ) : null}
      {activeTab() === "settings" ? (
        <div class="card bg-base-100 w-full shadow">
          <div class="card-body gap-4">
            <AppSettingsPanel />
          </div>
        </div>
      ) : null}
    </div>
  );
}
