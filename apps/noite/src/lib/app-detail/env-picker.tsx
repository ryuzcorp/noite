import { resourceValue } from "../resource";
import { environments } from "../resources";
//! Environment picker shared by the telemetry tabs: Production first, then
//! each preview environment by label. The tabs deep-link it through `?env=`
//! (the Deployments tab's convention); absent/unknown is production.
import type { RunnerEnvironment } from "../runner";
import { parseScope, scopeId } from "./route.machine";
import type { RouteNotice } from "./route.machine";

/** `?env=` validated against the app's environments: unknown ids (a deleted
 * environment, a stale link) fall back to production. */
export const validEnvId = (
  envs: readonly RunnerEnvironment[],
  raw: string
): string => scopeId(parseScope(raw, envs).scope);

/** A `?env=` that names an environment the app no longer has: the page shows
 * production, and says so, instead of pretending this is a preview. */
export const StaleEnvNotice = ({ notice }: { notice: RouteNotice }) =>
  notice._tag === "StaleEnvironment" ? (
    <p class="alert alert-warning m-0 py-2 text-sm" role="status">
      That environment no longer exists — showing Production instead.
    </p>
  ) : null;

/** Production + the app's environments, for the telemetry tabs. Hidden while
 * the app has no environments — then there is nothing to pick. */
export const EnvPicker = ({
  appId,
  onPick,
  value,
}: {
  appId: string;
  onPick: (id: string) => void;
  value: string;
}) => {
  const envs = resourceValue(environments(appId).state()) ?? [];

  if (envs.length === 0) {
    return null;
  }

  return (
    <label class="flex items-center gap-2 text-sm">
      <span class="opacity-70">Environment</span>
      <select
        class="select select-sm w-44"
        aria-label="Environment"
        value={value}
        onchange={(e) => {
          onPick(e.currentTarget.value);
        }}
      >
        <option value="">Production</option>
        {envs.map((env) => (
          <option key={env.id} value={env.id} selected={value === env.id}>
            {env.label}
          </option>
        ))}
      </select>
    </label>
  );
};
