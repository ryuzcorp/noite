//! Settings view body: fetches the app's own role gate, then renders the
//! section `?section=` names full width. The sections (identity, domains,
//! rate limits, error reporting, collaborators, env, branch protection,
//! danger) are sub-navigation of this one view — `/apps/<id>/settings` — not a
//! side panel: the app page's tab row no longer carries a Settings item, the
//! sidebar does.

import { errorMessage } from "../../errors";
import { resourceValue, resourceError } from "../../resource";
import { appDetail, invalidate, keys } from "../../resources";
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

/** Settings view: one section, chosen by the page's `?section=`. Fetches its
 * own role gate so it stays independent of any other page's fetch (the same
 * `appDetail` resource, so this is never a second request). */
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

  const gate = {
    appId: info.app.id,
    myRole: info.myRole,
    name: info.app.name,
    slug: info.app.slug,
    subdomain: info.app.subdomain,
  };

  // The section list already hid the admin-only ones; the view repeats the
  // gate so a role change between renders can never paint a write form.
  const isAdmin = capabilities(gate.myRole).admin;

  if (section === "identity") {
    return (
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
    );
  }

  if (section === "domains") {
    return <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />;
  }

  if (section === "limits") {
    return <RateLimitsPanel appId={gate.appId} myRole={gate.myRole} />;
  }

  if (section === "error-reporting") {
    return <ErrorReportingPanel appId={gate.appId} myRole={gate.myRole} />;
  }

  if (section === "collaborators") {
    return <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />;
  }

  if (section === "env") {
    return <EnvVarsPanel appId={gate.appId} myRole={gate.myRole} />;
  }

  if (section === "branch-protection") {
    return isAdmin ? (
      <BranchProtectionPanel appId={gate.appId} myRole={gate.myRole} />
    ) : null;
  }

  return isAdmin ? (
    <AppDangerZone
      appId={gate.appId}
      name={gate.name}
      slug={gate.slug}
      subdomain={gate.subdomain}
      onSaved={() => {
        invalidate(keys.appDetail(gate.appId));
      }}
    />
  ) : null;
};
