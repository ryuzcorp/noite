import { AppSettingsView } from "$lib/app-detail/settings/view";
import { DetailShell } from "$lib/app-detail/shell";
import { resourceValue } from "$lib/resource";
import { appDetail } from "$lib/resources";
import { DocumentTitle } from "$lib/ui/document-title";
import { useParams } from "@ilha/void";

/** The app's settings (`/apps/<id>/settings`), a page of its own: every
 * section the role may see is stacked on this one page, each with its own
 * heading and save flow. Deep links (`?section=domains`) scroll to a section
 * instead of switching a tab; old `?panel=settings&section=…` links redirect
 * here from the app page (`legacySettingsHref`) and keep the section. */
const SettingsPageBody = ({ appId }: { appId: string }) => {
  const detail = resourceValue(appDetail(appId).state());

  return (
    <>
      <DocumentTitle
        title={`Settings · ${detail?.app.name ?? "App"} · Noite`}
      />
      <DetailShell
        header={<h1 class="m-0 text-xl font-semibold">Settings</h1>}
        panel={null}
      >
        <AppSettingsView appId={appId} />
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
