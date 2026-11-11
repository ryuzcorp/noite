//! Settings page body: fetches the app's own role gate, then stacks every
//! section the role may see on one page — Identity, Domains, Limits, Error
//! reporting, Collaborators, Environment, then Branch protection and Danger
//! zone for admins. There is no tab row: each section is its own heading with
//! a stable anchor (`?section=` scrolls to it, and the compact contents nav
//! links to it), and each panel keeps its own state machine and save flow.
//! The panels are components, so one section's save never touches another's
//! draft, and every section's resource starts loading in the same paint.

import { atom, watch } from "ilha";
import type { View } from "ilha";

import { errorMessage } from "../../errors";
import {
  collectRef,
  liveEl,
  newLiveRef,
  whenFrame,
  whenLive,
} from "../../live-ref";
import { resourceValue, resourceError } from "../../resource";
import { appDetail, invalidate, keys } from "../../resources";
import type { AppRole } from "../../roles";
import { searchParam } from "../../search-param";
import { SectionSkeleton } from "../../ui/skeletons";
import { capabilities } from "../capabilities";
import {
  parseSettingsSection,
  settingsSectionLabel,
  settingsSectionsFor,
} from "../route.machine";
import type { SettingsSection as SettingsSectionId } from "../route.machine";
import { BranchProtectionPanel } from "./branch-protection";
import { CollaboratorsPanel } from "./collaborators";
import { AppDangerZone } from "./danger";
import { CustomDomainsPanel } from "./domains";
import { EnvVarsPanel } from "./env";
import { ErrorReportingPanel } from "./error-reporting";
import { AppIdentityForm } from "./identity";
import { RateLimitsPanel } from "./limits";
import { settingsSectionAnchor } from "./section";

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
 * page and the URL parser already keep them out of a non-admin's view. */
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
} as const satisfies Record<SettingsSectionId, (gate: SettingsGate) => View>;

/** The stacked sections, their contents nav, and the deep-link scroll. A
 * child component so its `atom`/`watch` slots only exist once the role is
 * known (the panels below need the gate). */
const SettingsSections = ({
  gate,
  sections,
}: {
  gate: SettingsGate;
  sections: readonly SettingsSectionId[];
}) => {
  const rawSection = searchParam("section", { default: "" });
  const isAdmin = capabilities(gate.myRole).admin;
  const anchor = parseSettingsSection(rawSection(), isAdmin);
  const box = atom.lazy(newLiveRef<HTMLDivElement>)();

  // A shared link (`?section=domains`, or the old `?panel=settings` redirect)
  // opens on that section. One scroll per mount: the redirect lands as a new
  // page, and the contents nav scrolls directly.
  watch.once(async ({ signal }) => {
    if (typeof window === "undefined" || anchor === null) {
      return;
    }

    const host = await whenLive(box, signal);

    if (!host) {
      return;
    }

    // Sections above the target grow as their own resources answer: wait
    // until none is still a skeleton (no `role=status`), so the heading is
    // where the final layout puts it, not where it sat for a frame.
    const heading = await whenFrame(() => {
      const el = host.querySelector(`#${settingsSectionAnchor(anchor)}`);

      return el && host.querySelector('[role="status"]') === null ? el : null;
    }, signal);

    (
      heading ?? host.querySelector(`#${settingsSectionAnchor(anchor)}`)
    )?.scrollIntoView({ block: "start" });
  });

  const jump = (section: SettingsSectionId): void => {
    rawSection.set(section);
    liveEl(box)
      ?.querySelector(`#${settingsSectionAnchor(section)}`)
      ?.scrollIntoView({ block: "start" });
  };

  return (
    <div class="flex w-full max-w-3xl flex-col gap-6">
      <nav aria-label="Settings sections" class="m-0">
        <ul class="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-sm">
          {sections.map((section) => (
            <li key={section}>
              <button
                type="button"
                class="link link-hover"
                onclick={() => {
                  jump(section);
                }}
              >
                {settingsSectionLabel(section)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div ref={(el) => collectRef(box, el)} class="flex flex-col gap-10">
        {sections.map((section) => SECTION_VIEWS[section](gate))}
      </div>
    </div>
  );
};

/** The app's whole Settings page. Fetches its own role gate so it stays
 * independent of any other page's fetch (the same `appDetail` resource, so
 * this is never a second request). */
export const AppSettingsView = ({ appId }: { appId: string }) => {
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

  return (
    <SettingsSections
      gate={{
        appId: info.app.id,
        myRole: info.myRole,
        name: info.app.name,
        slug: info.app.slug,
        subdomain: info.app.subdomain,
      }}
      sections={settingsSectionsFor(capabilities(info.myRole).admin)}
    />
  );
};
