//! Settings panel body: fetches the app's own role gate, then stacks the
//! sections (identity, domains, rate limits, collaborators, env, branch
//! protection, danger), separated by dividers.

import { useRoute } from "@ilha/router";

import { errorMessage } from "../../errors";
import { appDetail, invalidate, keys } from "../../resources";
import { SectionSkeleton } from "../../ui/skeletons";
import { BranchProtectionPanel } from "./branch-protection";
import { CollaboratorsPanel } from "./collaborators";
import { AppDangerZone } from "./danger";
import { CustomDomainsPanel } from "./domains";
import { EnvVarsPanel } from "./env";
import { AppIdentityForm } from "./identity";
import { RateLimitsPanel } from "./limits";

/** A section's slot: spacing between the dividers. */
const SECTION_CLASS = "py-5";

/** Settings panel: identity form above collaborator management. Fetches its
 * own role gate so it stays independent of the overview fetch. */
export const AppSettingsPanel = () => {
  const { params } = useRoute();
  const { id } = params();
  const res = appDetail(id ?? "");
  const info = res.data();
  if (!id) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id</p>;
  }
  if (res.loading() && info === undefined) {
    return (
      <div class="p-4">
        <SectionSkeleton lines={4} />
      </div>
    );
  }
  const loadError = res.error();
  if (loadError && !info) {
    return <p class="text-error m-0 p-4 text-sm">{errorMessage(loadError)}</p>;
  }
  if (!info) {
    return null;
  }
  const gate = {
    appId: info.app.id,
    myRole: info.myRole,
    name: info.app.name,
    slug: info.app.slug,
  };
  const isAdmin = gate.myRole === "admin";
  return (
    <div class="divide-base-300 flex flex-col divide-y px-4">
      <div class={SECTION_CLASS}>
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
      </div>
      <div class={SECTION_CLASS}>
        <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />
      </div>
      <div class={SECTION_CLASS}>
        <RateLimitsPanel appId={gate.appId} myRole={gate.myRole} />
      </div>
      <div class={SECTION_CLASS}>
        <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />
      </div>
      <div class={SECTION_CLASS}>
        <EnvVarsPanel appId={gate.appId} myRole={gate.myRole} />
      </div>
      {isAdmin ? (
        <div class={SECTION_CLASS}>
          <BranchProtectionPanel appId={gate.appId} myRole={gate.myRole} />
        </div>
      ) : null}
      {isAdmin ? (
        <div class={SECTION_CLASS}>
          <AppDangerZone
            appId={gate.appId}
            name={gate.name}
            slug={gate.slug}
            onSaved={() => {
              invalidate(keys.appDetail(gate.appId));
            }}
          />
        </div>
      ) : null}
    </div>
  );
};
