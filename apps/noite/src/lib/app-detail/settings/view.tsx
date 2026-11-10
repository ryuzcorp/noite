//! Settings view body: fetches the app's own role gate, then renders the
//! section `?section=` names full width. The sections (identity, domains,
//! rate limits, error reporting, collaborators, env, branch protection,
//! danger) are sub-navigation of this one view — `/apps/<id>/settings` — not a
//! side panel: the app page's tab row no longer carries a Settings item, the
//! sidebar does.

import type { View } from "ilha";

import { errorMessage } from "../../errors";
import { resourceValue, resourceError } from "../../resource";
import { appDetail, invalidate, keys } from "../../resources";
import type { AppRole } from "../../roles";
import { SectionSkeleton } from "../../ui/skeletons";
import { capabilities } from "../capabilities";
import type { SettingsSection } from "../route.machine";
import { BranchProtectionPanel } from "./branch-protection";
import { CollaboratorsPanel } from "./collaborators";
import { AppDangerZone } from "./danger";
import { CustomDomainsPanel } from "./domains";
import { EnvVarsPanel } from "./env";
import { ErrorReportingPanel } from "./error-reporting";
import { AppIdentityForm } from "./identity";
import { RateLimitsPanel } from "./limits";

/** What a section renders: the app's own row, gated by the role the server
 * answered with. */
interface SettingsGate {
  readonly appId: string;
  readonly myRole: AppRole;
  readonly name: string;
  readonly slug: string;
  readonly subdomain: string;
}

/** Every section's body, one entry per `SettingsSection` (the `satisfies`
 * makes a new section id a build error until its body is here). The
 * admin-only sections re-check the gate before painting a write form — the
 * tab row and the URL parser already kept them out of a non-admin's view. */
const SECTION_VIEWS = {
  "branch-protection": (gate) =>
    capabilities(gate.myRole).admin ? (
      <BranchProtectionPanel appId={gate.appId} myRole={gate.myRole} />
    ) : null,
  collaborators: (gate) => (
    <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />
  ),
  danger: (gate) =>
    capabilities(gate.myRole).admin ? (
      <AppDangerZone
        appId={gate.appId}
        name={gate.name}
        slug={gate.slug}
        subdomain={gate.subdomain}
        onSaved={() => {
          invalidate(keys.appDetail(gate.appId));
        }}
      />
    ) : null,
  domains: (gate) => (
    <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />
  ),
  env: (gate) => <EnvVarsPanel appId={gate.appId} myRole={gate.myRole} />,
  "error-reporting": (gate) => (
    <ErrorReportingPanel appId={gate.appId} myRole={gate.myRole} />
  ),
  identity: (gate) => (
    <AppIdentityForm
      appId={gate.appId}
      name={gate.name}
      myRole={gate.myRole}
      onSaved={() => {
        // invalidate (not res.refetch): the page title and the header
        // dropdown read this key through their own resource cells.
        invalidate(keys.appDetail(gate.appId));
      }}
    />
  ),
  limits: (gate) => <RateLimitsPanel appId={gate.appId} myRole={gate.myRole} />,
} as const satisfies Record<SettingsSection, (gate: SettingsGate) => View>;

/** One section of the Settings view, chosen by the page's `?section=`. Fetches
 * its own role gate so it stays independent of any other page's fetch (the
 * same `appDetail` resource, so this is never a second request). */
export const AppSettingsView = ({
  appId,
  section,
}: {
  appId: string;
  section: SettingsSection;
}) => {
  const res = appDetail(appId);
  const info = resourceValue(res.state());

  if (res.state()._tag === "Loading") {
    return <SectionSkeleton lines={4} />;
  }

  const loadError = resourceError(res.state());

  if (loadError && !info) {
    return <p class="text-error m-0 text-sm">{errorMessage(loadError)}</p>;
  }

  if (!info) {
    return null;
  }

  return SECTION_VIEWS[section]({
    appId: info.app.id,
    myRole: info.myRole,
    name: info.app.name,
    slug: info.app.slug,
    subdomain: info.app.subdomain,
  });
};
