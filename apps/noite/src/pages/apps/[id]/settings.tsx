import { capabilities } from "$lib/app-detail/capabilities";
import {
  parseSettingsSection,
  settingsSectionLabel,
  settingsSectionsFor,
} from "$lib/app-detail/route.machine";
import { AppSettingsView } from "$lib/app-detail/settings/view";
import { DetailShell, DetailTabs } from "$lib/app-detail/shell";
import { resourceValue } from "$lib/resource";
import { appDetail } from "$lib/resources";
import { searchParam } from "$lib/search-param";
import { DocumentTitle } from "$lib/ui/document-title";
import { useParams } from "@ilha/void";

const TAB_PREFIX = "settings";

/** The app's settings (`/apps/<id>/settings`), a view of its own: the
 * sections are tabs on the shared detail layout, and `?section=` picks one,
 * so an old `?panel=settings&section=domains` link lands on Domains through
 * the redirect in the app page (`legacySettingsHref`). Admin-only sections
 * are not in the row for anyone else, and the parser sends their shared
 * links to the default section. */
const SettingsPageBody = ({ appId }: { appId: string }) => {
  const detail = resourceValue(appDetail(appId).state());
  const isAdmin = detail ? capabilities(detail.myRole).admin : false;

  // The raw param, parsed here rather than through `parse`: the role gate is
  // part of the answer, and it lands after the first paint.
  const rawSection = searchParam("section", { default: "" });
  const active = parseSettingsSection(rawSection(), isAdmin);
  const sections = settingsSectionsFor(isAdmin);

  const tab = `${TAB_PREFIX}-tab-${active}`;
  const panel = `${TAB_PREFIX}-panel-${active}`;

  return (
    <>
      <DocumentTitle
        title={`Settings · ${detail?.app.name ?? "App"} · Noite`}
      />
      <DetailShell
        header={
          <>
            <h1 class="m-0 text-xl font-semibold">Settings</h1>
            <DetailTabs
              active={active}
              idPrefix={TAB_PREFIX}
              onSelect={(id) => {
                rawSection.set(parseSettingsSection(id, isAdmin));
              }}
              tabs={sections.map((section) => ({
                id: section,
                label: settingsSectionLabel(section),
              }))}
            />
          </>
        }
        panel={null}
      >
        <div
          id={panel}
          role="tabpanel"
          aria-labelledby={tab}
          class="flex w-full max-w-3xl flex-col gap-4"
        >
          <AppSettingsView appId={appId} section={active} />
        </div>
      </DetailShell>
    </>
  );
};

/** Page shell: resolves the route param, then renders a body keyed by it
 * (page components are reused across navigations, see the app page). */
export default function SettingsPage() {
  const { id: appId } = useParams();

  if (!appId) {
    return <p class="m-0 text-sm opacity-70">Missing app id.</p>;
  }

  return [<SettingsPageBody key={appId} appId={appId} />];
}
