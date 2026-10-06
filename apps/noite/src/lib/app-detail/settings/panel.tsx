//! Settings tab shell: fetches the app's own role gate, then stacks the
//! panels (identity, domains, rate limits, collaborators, env, danger).

import { useRoute } from "@ilha/router";

import { errorMessage } from "../../errors";
import { appDetail, invalidate, keys } from "../../resources";
import { SectionSkeleton } from "../../ui/skeletons";
import { CollaboratorsPanel } from "./collaborators";
import { AppDangerZone } from "./danger";
import { CustomDomainsPanel } from "./domains";
import { EnvVarsPanel } from "./env";
import { AppIdentityForm } from "./identity";
import { RateLimitsPanel } from "./limits";

/** Settings tab: identity form above collaborator management. Fetches its
 * own role gate so the tab stays independent of the overview fetch. */
export const AppSettingsPanel = () => {
  const { params } = useRoute();
  const { id } = params();
  const res = appDetail(id ?? "");
  const info = res.data();
  if (!id) {
    return <p class="text-error m-0 text-sm">Missing app id</p>;
  }
  if (res.loading() && info === undefined) {
    return <SectionSkeleton lines={4} />;
  }
  const loadError = res.error();
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
  };
  return (
    <div class="flex flex-col gap-4">
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
      <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />
      <RateLimitsPanel appId={gate.appId} myRole={gate.myRole} />
      <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />
      <EnvVarsPanel appId={gate.appId} myRole={gate.myRole} />
      {gate.myRole === "admin" ? (
        <AppDangerZone
          appId={gate.appId}
          name={gate.name}
          slug={gate.slug}
          onSaved={() => {
            invalidate(keys.appDetail(gate.appId));
          }}
        />
      ) : null}
    </div>
  );
};
