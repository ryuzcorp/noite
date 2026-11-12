//! The environment groups on the Deployments tab: one preview environment per
//! group — its header (label, kind, tracked ref, status, last deploy, URL,
//! public toggle, redeploy, delete) above its own deploy history, each with a
//! variable-override editor — plus the Create environment dialog.
//!
//! The runner enforces the app role on every call; this only mirrors it in the
//! UI (create/redeploy/overrides = `push`, public toggle/delete = `admin`).
//! The header's actions, the override editor and the branch picker are
//! explicit machines in `environment.machine.ts`.
import { defineApp } from "@ilha/model";
import type { UpdateResult } from "@ilha/model";
import { Link } from "@ilha/void";
import { atom, watch } from "ilha";
import type { AtomHandle, View } from "ilha";

import type { EnvironmentVarView } from "../api-types";
import { environmentHost, environmentUrl } from "../apps/identity";
import { forgeRefs } from "../forge/data";
import { commitHref, shortSha } from "../forge/format";
import { islandProps } from "../island";
import { collectRef, newLiveRef, whenLive } from "../live-ref";
import { resourceValue, resourceError } from "../resource";
import { environments, environmentVars } from "../resources";
import type { AppRole } from "../roles";
import type { RunnerEnvironment } from "../runner";
import { confirmDialog } from "../ui/confirm";
import { Dialog } from "../ui/dialog";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Key,
  Lock,
  Plus,
  Refresh,
  Trash,
} from "../ui/icons";
import { LoadError } from "../ui/load-error";
import { ListSkeleton } from "../ui/skeletons";
import { capabilities } from "./capabilities";
import {
  CreateMsg,
  CreatePhaseTypes,
  EnvAlertTypes,
  EnvOpTypes,
  GroupMsg,
  VarFormTypes,
  VarListTypes,
  VarsMsg,
  groupBusy,
  updateCreate,
  updateGroup,
  updateVars,
} from "./environment.machine";
import type {
  CreateMessage,
  CreateModel,
  GroupMessage,
  GroupModel,
  VarsMessage,
  VarsModel,
} from "./environment.machine";
import {
  appLifecycle,
  environmentHeaderState,
  lifecycleView,
} from "./lifecycle";
import type { StatusTone } from "./lifecycle";

/** A git ref as the name a group header can show: `refs/heads/x` and
 * `refs/tags/x` are the name itself. */
const trackedRef = (gitRef: string): string => {
  for (const prefix of ["refs/heads/", "refs/tags/"]) {
    if (gitRef.startsWith(prefix)) {
      return gitRef.slice(prefix.length);
    }
  }

  return gitRef;
};

/** A `FLAG_<NAME>` row is a feature flag: the toggle writes `1`/`0`. */
const isFlag = (name: string) => name.startsWith("FLAG_");

/** What a deploy group's header says after its name, identically for
 * Production and each environment: a status dot, the live commit and the
 * host it serves. `desiredState` makes a deliberate stop paint neutral even
 * while the observed status lags. */
export const DeployGroupMeta = ({
  appId,
  desiredState,
  host,
  sha,
  status,
  url,
}: {
  appId: string;
  desiredState?: string;
  host: string;
  sha: string | null;
  status: string;
  url: string;
}) => {
  const tone: StatusTone = lifecycleView(
    appLifecycle({ desiredState, status }),
    desiredState ?? "running"
  ).tone;

  return (
    <>
      <span class={`status ${tone}`} title={status}>
        <span class="sr-only">{status}</span>
      </span>
      {sha ? (
        <Link
          class="link link-hover text-base-content/70 font-mono text-xs"
          href={commitHref(appId, sha)}
          title={sha}
        >
          {shortSha(sha)}
        </Link>
      ) : (
        <span class="text-base-content/60 text-xs">not deployed</span>
      )}
      <a
        class="link link-hover text-base-content/70 inline-flex min-w-0 items-center gap-0.5 text-xs"
        href={url}
        target="_blank"
        rel="noopener"
        title={url}
      >
        <span class="truncate">{host}</span>
        <ArrowUpRight class="h-3 w-3 shrink-0" />
      </a>
    </>
  );
};

const VarsProps = islandProps<{
  appId: string;
  canWrite: boolean;
  envId: string;
  open: AtomHandle<boolean>;
}>("EnvironmentVars");

/** One environment's variable overrides: reads are view-gated, writes
 * push-gated server-side; the form locks for non-pushers. One machine
 * (`environment.machine.ts`) owns the dialog, the save and the delete, so a
 * validation error and a delete error never share a slot. */
const VarsApp = defineApp({
  init: (): UpdateResult<VarsModel, VarsMessage> => ({
    model: {
      appId: VarsProps.read().appId,
      envId: VarsProps.read().envId,
      form: VarFormTypes.Closed(),
      list: VarListTypes.Idle(),
      notice: "none",
    } satisfies VarsModel,
  }),
  update: updateVars,
  view: (model, dispatch) => {
    const props = VarsProps.read();
    const res = environmentVars(props.appId, props.envId);
    const rows: EnvironmentVarView[] = resourceValue(res.state()) ?? [];

    const reload = async (): Promise<void> => {
      await res.refetch();
    };

    const saving = model.form._tag === "Saving";
    const deleting = model.list._tag === "Deleting";

    return (
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <h4 class="m-0 text-sm font-semibold">Variable overrides</h4>
          {props.canWrite ? (
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                props.open.set(true);
                dispatch(VarsMsg.Opened());
              }}
            >
              <Plus />
              Add override
            </button>
          ) : null}
        </div>
        <p class="m-0 text-xs opacity-70">
          Overrides the app's variables for this environment only, in the build,
          the fleet, and Worker code (<code>env.NAME</code>). A change takes
          effect on the next deploy of this environment. Values are hidden after
          saving; <code>FLAG_</code> names render as on/off toggles. On Void
          apps, <code>VOID_PROXY_</code> names override the proxy-only
          credentials for this fleet alone.
        </p>
        {model.notice === "saved" ? (
          <p class="m-0 text-xs opacity-70">
            Saved. The next deploy picks it up — press Redeploy above to apply
            it now.
          </p>
        ) : null}
        {model.list._tag === "Failed" ? (
          <p class="text-error m-0 text-xs">
            Could not delete {model.list.name}: {model.list.error}
          </p>
        ) : null}
        <LoadError error={resourceError(res.state())} />
        {res.state()._tag === "Loading" ? <ListSkeleton rows={2} /> : null}
        {rows.length === 0 && resourceValue(res.state()) !== undefined ? (
          <p class="m-0 text-xs opacity-70">No overrides.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul class="list bg-base-100 dark:bg-base-200 w-full">
            {rows.map((row) => (
              <li
                key={row.name}
                class="list-row flex items-center justify-between gap-2"
              >
                <span class="font-mono text-sm">{row.name}</span>
                <span class="flex items-center gap-2">
                  {isFlag(row.name) ? (
                    <span class="font-mono text-xs">{row.value}</span>
                  ) : (
                    <span class="text-base-content/60 font-mono text-xs">
                      ••••••
                    </span>
                  )}
                  {props.canWrite ? (
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost shrink-0"
                      disabled={
                        deleting &&
                        model.list._tag === "Deleting" &&
                        model.list.name === row.name
                      }
                      onclick={async () => {
                        const ok = await confirmDialog({
                          confirmLabel: "Delete",
                          title: `Delete ${row.name}?`,
                        });

                        if (ok !== "confirm") {
                          return;
                        }

                        dispatch(
                          VarsMsg.DeleteRequested({
                            name: row.name,
                            reload,
                          })
                        );
                      }}
                    >
                      {model.list._tag === "Deleting" &&
                      model.list.name === row.name
                        ? "Deleting…"
                        : "Delete"}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {props.canWrite ? null : (
          <p class="m-0 text-xs opacity-70">
            Need <code>push</code> access to change overrides.
          </p>
        )}
        <Dialog
          open={props.open}
          class="modal"
          onClose={() => {
            dispatch(VarsMsg.Cancelled());
          }}
        >
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Add override</h3>
            <fieldset class="fieldset w-full">
              <label class="label" for={`env-var-name-${props.envId}`}>
                Name
              </label>
              <input
                id={`env-var-name-${props.envId}`}
                class="input input-sm w-full font-mono"
                placeholder="DATABASE_URL or FLAG_DARK_LAUNCH"
                value={model.form._tag === "Editing" ? model.form.name : ""}
                disabled={saving}
                oninput={(event) => {
                  dispatch(
                    VarsMsg.NameChanged({ value: event.currentTarget.value })
                  );
                }}
              />
            </fieldset>
            <fieldset class="fieldset w-full">
              <label class="label" for={`env-var-value-${props.envId}`}>
                Value
              </label>
              <input
                id={`env-var-value-${props.envId}`}
                class="input input-sm w-full font-mono"
                placeholder="value (flags use 1/0)"
                value={model.form._tag === "Editing" ? model.form.value : ""}
                disabled={saving}
                oninput={(event) => {
                  dispatch(
                    VarsMsg.ValueChanged({ value: event.currentTarget.value })
                  );
                }}
              />
            </fieldset>
            {model.form._tag === "Editing" && model.form.error ? (
              <p class="text-error m-0 text-sm">{model.form.error}</p>
            ) : null}
            <div class="modal-action">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={saving}
                onclick={() => {
                  props.open.set(false);
                  dispatch(VarsMsg.Cancelled());
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-sm btn-neutral"
                disabled={saving}
                onclick={() => {
                  dispatch(
                    VarsMsg.Submitted({
                      close: () => {
                        props.open.set(false);
                      },
                      reload,
                    })
                  );
                }}
              >
                {saving ? "Saving…" : "Add"}
              </button>
            </div>
          </div>
          <form method="dialog" class="modal-backdrop">
            <button
              aria-label="Close dialog"
              disabled={saving}
              onclick={() => {
                props.open.set(false);
                dispatch(VarsMsg.Cancelled());
              }}
            >
              close
            </button>
          </form>
        </Dialog>
      </div>
    );
  },
});

const VarsIsland = VarsProps.wrap(VarsApp);

/** One environment's variable overrides: `canWrite` mirrors the runner gate. */
const EnvironmentVars = ({
  appId,
  envId,
  myRole,
}: {
  appId: string;
  envId: string;
  myRole: AppRole | undefined;
}) => {
  const open = atom(false);

  return (
    <VarsIsland
      appId={appId}
      canWrite={capabilities(myRole).push}
      envId={envId}
      open={open}
    />
  );
};

const GroupProps = islandProps<{
  appId: string;
  children: View;
  defaultOpen: boolean;
  env: RunnerEnvironment;
  myRole: AppRole | undefined;
  subdomain: string;
}>("EnvironmentGroup");

/** One environment as a group on the Deployments tab: the header carries the
 * environment's details and actions, and `children` is its deploy history —
 * rendered only while expanded, so a collapsed group opens no SSE feed. */
const GroupApp = defineApp({
  init: (): UpdateResult<GroupModel, GroupMessage> => {
    const props = GroupProps.read();

    return {
      model: {
        alert: EnvAlertTypes.None(),
        appId: props.appId,
        envId: props.env.id,
        expanded: props.defaultOpen,
        op: EnvOpTypes.Idle(),
        varsOpen: false,
      } satisfies GroupModel,
    };
  },
  update: updateGroup,
  view: (model, dispatch) => {
    const props = GroupProps.read();
    const { env } = props;
    const caps = capabilities(props.myRole);
    const url = environmentUrl(props.subdomain, env.label);
    const branch = trackedRef(env.gitRef);
    const header = environmentHeaderState(env);
    const pending = groupBusy(model);

    // Say what it tracks only when the label is not the branch (a branch name
    // the label had to sanitize).
    const tracks = branch === env.label ? null : branch;

    // Scroll a deep-linked group into view once, waiting out the first ref.
    const box = atom.lazy(newLiveRef<HTMLElement>)();

    if (props.defaultOpen) {
      watch.once(async ({ signal }) => {
        const el = await whenLive(box, signal);
        el?.scrollIntoView({ block: "start" });
      });
    }

    const alertText = ((): string | null => {
      if (model.alert._tag !== "Failed") {
        return null;
      }

      switch (model.alert.op) {
        case "public": {
          return `Public setting not saved: ${model.alert.error}`;
        }

        case "deploy": {
          return `Redeploy failed: ${model.alert.error}`;
        }

        default: {
          return `Delete failed: ${model.alert.error}`;
        }
      }
    })();

    return (
      <section
        class="flex w-full flex-col gap-2"
        id={`environment-${env.id}`}
        ref={(el) => {
          collectRef(box, el);
        }}
      >
        <div class="bg-base-100 dark:bg-base-200 border-base-300 rounded-box flex w-full flex-col gap-2 border px-4 py-3 shadow-md">
          <div class="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              class="btn btn-sm btn-ghost btn-square -ml-2 shrink-0"
              aria-expanded={model.expanded}
              aria-label={`${model.expanded ? "Hide" : "Show"} ${env.label} deploy history`}
              onclick={() => {
                dispatch(GroupMsg.ExpandedToggled());
              }}
            >
              {model.expanded ? <ChevronUp /> : <ChevronDown />}
            </button>
            <span class="text-lg font-semibold">{env.label}</span>
            {tracks ? (
              <span class="text-base-content/60 inline-flex items-center gap-1 text-xs">
                <GitBranch class="h-3 w-3" />
                {tracks}
              </span>
            ) : null}
            <DeployGroupMeta
              appId={props.appId}
              desiredState={env.desiredState}
              host={environmentHost(props.subdomain, env.label)}
              sha={env.lastDeploySha}
              status={env.status}
              url={url}
            />
            {header.stopped ? (
              <span class="badge badge-sm" title="desired_state = stopped">
                Stopped
              </span>
            ) : null}
            <span class="ml-auto flex items-center gap-1">
              {caps.admin ? (
                <label
                  class="mr-2 flex cursor-pointer items-center gap-1.5 text-xs"
                  title="Public: anyone with the URL. Off: app members only."
                >
                  <input
                    type="checkbox"
                    class="toggle toggle-xs"
                    aria-label={`Public ${env.label}`}
                    checked={env.public}
                    disabled={pending}
                    onchange={(event) => {
                      dispatch(
                        GroupMsg.PublicRequested({
                          value: event.currentTarget.checked,
                        })
                      );
                    }}
                  />
                  Public
                </label>
              ) : (
                <span class="text-base-content/70 mr-2 inline-flex items-center gap-1 text-xs">
                  {env.public ? null : <Lock class="h-3 w-3" />}
                  {env.public ? "Public" : "Members only"}
                </span>
              )}
              {caps.push ? (
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={pending}
                  onclick={() => {
                    dispatch(GroupMsg.RedeployRequested());
                  }}
                >
                  <Refresh />
                  {model.op._tag === "Deploying" ? "Redeploying…" : "Redeploy"}
                </button>
              ) : null}
              <button
                type="button"
                class={`btn btn-sm btn-ghost ${model.varsOpen ? "btn-active" : ""}`}
                aria-expanded={model.varsOpen}
                onclick={() => {
                  dispatch(GroupMsg.VarsToggled());
                }}
              >
                <Key />
                Variables
              </button>
              {caps.admin ? (
                <button
                  type="button"
                  class="btn btn-sm btn-ghost btn-square hover:text-error"
                  disabled={pending}
                  aria-label={`Delete ${env.label}`}
                  title="Delete environment"
                  onclick={async () => {
                    const ok = await confirmDialog({
                      confirmLabel: "Delete",
                      title: `Delete ${env.label}?`,
                    });

                    if (ok !== "confirm") {
                      return;
                    }

                    dispatch(GroupMsg.DeleteRequested());
                  }}
                >
                  <Trash />
                </button>
              ) : null}
            </span>
          </div>
          {alertText ? <p class="text-error m-0 text-xs">{alertText}</p> : null}
          {header.stopped ? (
            <p class="m-0 text-xs opacity-70">
              This environment is stopped: it is not serving traffic, and a
              deploy will not start it.
            </p>
          ) : null}
          {header.error ? (
            <p class="text-error m-0 text-xs break-words">{header.error}</p>
          ) : null}
          {model.varsOpen ? (
            <div class="border-base-300 w-full border-t pt-2">
              <EnvironmentVars
                appId={props.appId}
                envId={env.id}
                myRole={props.myRole}
              />
            </div>
          ) : null}
        </div>
        {model.expanded ? props.children : null}
      </section>
    );
  },
});

const GroupIsland = GroupProps.wrap(GroupApp);

/** One environment as a group on the Deployments tab: the header carries the
 * environment's details and actions, and `children` is its deploy history —
 * rendered only while expanded, so a collapsed group opens no SSE feed. */
export const EnvironmentGroup = ({
  appId,
  children,
  defaultOpen = false,
  env,
  myRole,
  subdomain,
}: {
  appId: string;
  /** The environment's deploy history (its own scoped feed). */
  children: View;
  /** Deep-linked (`?env=<id>`): start expanded and scroll the group into view. */
  defaultOpen?: boolean;
  env: RunnerEnvironment;
  myRole: AppRole | undefined;
  subdomain: string;
}) => (
  <GroupIsland
    appId={appId}
    children={children}
    defaultOpen={defaultOpen}
    env={env}
    myRole={myRole}
    subdomain={subdomain}
  />
);

const CreateProps = islandProps<{
  appId: string;
  available: readonly string[];
  initialBranch: string;
  onCreated: (env: RunnerEnvironment | null) => void;
  open: AtomHandle<boolean>;
}>("CreateEnvironmentDialog");

/** Create environment: a branch picker; the runner derives the label. Never
 * substitutes a branch: the selection resets when its branch leaves the list
 * (the island is keyed by the available set) and a submit for a branch that
 * is gone is refused. */
const CreateApp = defineApp({
  init: (): UpdateResult<CreateModel, CreateMessage> => {
    const props = CreateProps.read();

    return {
      model: {
        branch: props.available.includes(props.initialBranch)
          ? props.initialBranch
          : null,
        phase: CreatePhaseTypes.Picking(),
      } satisfies CreateModel,
    };
  },
  update: updateCreate,
  view: (model, dispatch) => {
    const props = CreateProps.read();
    const submitting = model.phase._tag === "Submitting";

    const picked =
      model.branch !== null && props.available.includes(model.branch);

    return (
      <Dialog open={props.open} class="modal">
        <div class="modal-box bg-base-100 dark:bg-base-200">
          <h3 class="m-0 text-lg font-bold">Create environment</h3>
          <p class="m-0 py-2 text-sm opacity-80">
            Deploys the branch's head into its own environment. The label is
            derived from the branch name.
          </p>
          <fieldset class="fieldset w-full">
            <label class="label" for="env-branch">
              Branch
            </label>
            {props.available.length === 0 ? (
              <p class="m-0 text-sm opacity-70">
                Every branch other than the default already has an environment.
                Push a new branch to create another.
              </p>
            ) : (
              <select
                id="env-branch"
                class="select select-sm w-full"
                value={model.branch ?? ""}
                disabled={submitting}
                onchange={(event) => {
                  dispatch(
                    CreateMsg.BranchPicked({ name: event.currentTarget.value })
                  );
                }}
              >
                <option value="">Choose a branch…</option>
                {props.available.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
          {model.phase._tag === "Rejected" ? (
            <p class="text-error m-0 text-sm">{model.phase.reason}</p>
          ) : null}
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={submitting}
              onclick={() => {
                props.open.set(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={submitting || !picked}
              onclick={() => {
                dispatch(
                  CreateMsg.Submitted({
                    appId: props.appId,
                    available: props.available,
                    onCreated: props.onCreated,
                  })
                );
              }}
            >
              {submitting ? "Creating…" : "Create environment"}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button
            aria-label="Close dialog"
            disabled={submitting}
            onclick={() => {
              props.open.set(false);
            }}
          >
            close
          </button>
        </form>
      </Dialog>
    );
  },
});

const CreateIsland = CreateProps.wrap(CreateApp);

/** Create environment: a branch picker; the runner derives the label. The
 * island is keyed by the available branch set, so a branch that disappears
 * resets the selection instead of silently becoming the first one. */
export const CreateEnvironmentDialog = ({
  appId,
  initialBranch = "",
  onCreated,
  open,
}: {
  appId: string;
  /** Preselect a branch in the picker (the PR card passes the head branch);
   * falls back to nothing when it has no environment. */
  initialBranch?: string;
  /** After the runner creates the environment (used to deep-link its group). */
  onCreated?: (env: RunnerEnvironment) => void;
  open: AtomHandle<boolean>;
}) => {
  const refs = resourceValue(forgeRefs(appId).state());
  const envs = resourceValue(environments(appId).state()) ?? [];

  // Only branches that can get one: the default branch is the app itself, and
  // a branch already tracked by an environment has it (the runner refuses
  // both, so offering them only produces an error).
  const available = (refs?.branches ?? [])
    .filter(
      (one) =>
        one.name !== refs?.defaultBranch &&
        !envs.some((env) => env.gitRef === `refs/heads/${one.name}`)
    )
    .map((one) => one.name);

  return (
    <CreateIsland
      key={available.join("\u0000")}
      appId={appId}
      available={available}
      initialBranch={initialBranch}
      onCreated={(env) => {
        if (env) {
          open.set(false);
          onCreated?.(env);
        }

        // A null answer (nothing created) leaves the dialog open; the machine
        // paints the runner's reason.
      }}
      open={open}
    />
  );
};
