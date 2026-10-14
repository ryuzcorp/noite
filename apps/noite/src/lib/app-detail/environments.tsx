//! The environment groups on the Deployments tab: one preview environment per
//! group — its header (label, kind, tracked ref, status, last deploy, URL,
//! public toggle, redeploy, delete) above its own deploy history, each with a
//! variable-override editor — plus the Create environment dialog.
//!
//! The runner enforces the app role on every call; this only mirrors it in the
//! UI (create/redeploy/overrides = `push`, public toggle/delete = `admin`).

import { atom, watch } from "ilha";
import type { AtomHandle, View } from "ilha";

import {
  environmentHost,
  environmentUrl,
  presenceTone,
} from "../apps/identity";
import { errorMessage } from "../errors";
import { forgeRefs } from "../forge/data";
import { commitHref, shortSha } from "../forge/format";
import { collectRef, newLiveRef, whenLive } from "../live-ref";
import { environments, environmentVars, invalidate, keys } from "../resources";
import type { AppRole } from "../roles";
import type { RunnerEnvironment } from "../runner";
import type { EnvironmentVarView } from "../server/environments.server";
import {
  createEnvironment,
  deleteEnvironment,
  deleteEnvironmentVar,
  deployEnvironment,
  setEnvironmentVar,
  updateEnvironment,
} from "../server/environments.server";
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

/** A git ref as the name a group header can show: `refs/heads/x` and
 * `refs/tags/x` are the name itself, while a workspace preview's hidden
 * `refs/previews/<user>/<branch>` carries the *user* segment the UI has no use
 * for — the branch is what the environment tracks. */
const trackedRef = (gitRef: string): string => {
  for (const prefix of ["refs/heads/", "refs/tags/"]) {
    if (gitRef.startsWith(prefix)) {
      return gitRef.slice(prefix.length);
    }
  }
  const preview = "refs/previews/";
  if (gitRef.startsWith(preview)) {
    // Only the user segment goes: a branch name may hold slashes of its own.
    const rest = gitRef.slice(preview.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? rest : rest.slice(slash + 1);
  }
  return gitRef;
};

/** A `FLAG_<NAME>` row is a feature flag: the toggle writes `1`/`0`. */
const isFlag = (name: string) => name.startsWith("FLAG_");

/** What a deploy group's header says after its name, identically for
 * Production and each environment: a status dot, the live commit and the
 * host it serves. */
export const DeployGroupMeta = ({
  appId,
  host,
  sha,
  status,
  url,
}: {
  appId: string;
  host: string;
  sha: string | null;
  status: string;
  url: string;
}) => (
  <>
    <span class={`status ${presenceTone(status)}`} title={status}>
      <span class="sr-only">{status}</span>
    </span>
    {sha ? (
      <a
        class="link link-hover text-base-content/70 font-mono text-xs"
        href={commitHref(appId, sha)}
        title={sha}
      >
        {shortSha(sha)}
      </a>
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

/** One environment's variable overrides: reads are view-gated, writes
 * push-gated server-side; the form locks for non-pushers. */
const EnvironmentVars = ({
  appId,
  envId,
  myRole,
}: {
  appId: string;
  envId: string;
  myRole: AppRole | undefined;
}) => {
  const res = environmentVars(appId, envId);
  const rows: EnvironmentVarView[] = res.data() ?? [];
  const err = atom("");
  const busy = atom(false);
  const open = atom(false);
  const name = atom("");
  const value = atom("");
  const canWrite = myRole === "push" || myRole === "admin";
  const reload = async () => {
    try {
      await res.refetch();
      err.set("");
    } catch (error) {
      err.set(errorMessage(error));
    }
  };
  const submit = () => {
    if (busy()) {
      return;
    }
    const raw = name().trim();
    if (!raw) {
      err.set("Name is required");
      return;
    }
    busy.set(true);
    err.set("");
    void (async () => {
      try {
        await setEnvironmentVar({ appId, envId, name: raw, value: value() });
        name.set("");
        value.set("");
        open.set(false);
        await reload();
      } catch (error) {
        err.set(errorMessage(error));
      }
      busy.set(false);
    })();
  };
  const remove = async (row: EnvironmentVarView) => {
    const ok = await confirmDialog({
      confirmLabel: "Delete",
      title: `Delete ${row.name}?`,
    });
    if (!ok) {
      return;
    }
    busy.set(true);
    try {
      await deleteEnvironmentVar({ appId, envId, name: row.name });
      await reload();
    } catch (error) {
      err.set(errorMessage(error));
    }
    busy.set(false);
  };
  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <h4 class="m-0 text-sm font-semibold">Variable overrides</h4>
        {canWrite ? (
          <button
            type="button"
            class="btn btn-sm"
            onclick={() => {
              err.set("");
              name.set("");
              value.set("");
              open.set(true);
            }}
          >
            <Plus />
            Add override
          </button>
        ) : null}
      </div>
      <p class="m-0 text-xs opacity-70">
        Overrides the app's variables for this environment only. Values are
        hidden after saving; <code>FLAG_</code> names render as on/off toggles.
      </p>
      {err() ? <p class="text-error m-0 text-xs">{err()}</p> : null}
      <LoadError error={res.error()} />
      {res.loading() && res.data() === undefined ? (
        <ListSkeleton rows={2} />
      ) : null}
      {rows.length === 0 && res.data() !== undefined ? (
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
                {canWrite ? (
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost shrink-0"
                    disabled={busy()}
                    onclick={() => {
                      void remove(row);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {canWrite ? null : (
        <p class="m-0 text-xs opacity-70">
          Need <code>push</code> access to change overrides.
        </p>
      )}
      <Dialog open={open} class="modal">
        <div class="modal-box bg-base-100 dark:bg-base-200">
          <h3 class="m-0 text-lg font-bold">Add override</h3>
          <fieldset class="fieldset w-full">
            <label class="label" for={`env-var-name-${envId}`}>
              Name
            </label>
            <input
              id={`env-var-name-${envId}`}
              class="input input-sm w-full font-mono"
              placeholder="DATABASE_URL or FLAG_DARK_LAUNCH"
              value={name()}
              oninput={(event) => {
                name.set(event.currentTarget.value);
              }}
            />
          </fieldset>
          <fieldset class="fieldset w-full">
            <label class="label" for={`env-var-value-${envId}`}>
              Value
            </label>
            <input
              id={`env-var-value-${envId}`}
              class="input input-sm w-full font-mono"
              placeholder="value (flags use 1/0)"
              value={value()}
              oninput={(event) => {
                value.set(event.currentTarget.value);
              }}
            />
          </fieldset>
          {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={busy()}
              onclick={() => {
                open.set(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={busy()}
              onclick={submit}
            >
              {busy() ? "Saving…" : "Add"}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button aria-label="Close dialog" disabled={busy()}>
            close
          </button>
        </form>
      </Dialog>
    </div>
  );
};

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
}) => {
  const open = atom(defaultOpen);
  const varsOpen = atom(false);
  const busy = atom(false);
  const err = atom("");
  const isAdmin = myRole === "admin";
  const canPush = myRole === "push" || myRole === "admin";
  const url = environmentUrl(subdomain, env.label);
  const branch = trackedRef(env.gitRef);
  // The label usually is the branch; say what it tracks only when it is not
  // (a workspace preview, or a branch name the label had to sanitize).
  let tracks: string | null = null;
  if (env.kind === "workspace") {
    tracks = `Preview of ${branch}`;
  } else if (branch !== env.label) {
    tracks = branch;
  }
  // Scroll the group into view the first time it expands — a deep link lands
  // on it, and a manual expand reveals it. `whenLive` waits out the first ref.
  const box = atom.lazy(newLiveRef<HTMLElement>)();
  const scrolled = atom.lazy(() => ({ done: false }))();
  watch(open, (isOpen, { signal }) => {
    if (!isOpen || scrolled.done) {
      return;
    }
    scrolled.done = true;
    void (async () => {
      const el = await whenLive(box, signal);
      el?.scrollIntoView({ block: "start" });
    })();
  });
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
            aria-expanded={open()}
            aria-label={`${open() ? "Hide" : "Show"} ${env.label} deploy history`}
            onclick={() => {
              open.set(!open());
            }}
          >
            {open() ? <ChevronUp /> : <ChevronDown />}
          </button>
          <span class="text-lg font-semibold">{env.label}</span>
          {tracks ? (
            <span class="text-base-content/60 inline-flex items-center gap-1 text-xs">
              <GitBranch class="h-3 w-3" />
              {tracks}
            </span>
          ) : null}
          <DeployGroupMeta
            appId={appId}
            host={environmentHost(subdomain, env.label)}
            sha={env.lastDeploySha}
            status={env.status}
            url={url}
          />
          <span class="ml-auto flex items-center gap-1">
            {isAdmin ? (
              <label
                class="mr-2 flex cursor-pointer items-center gap-1.5 text-xs"
                title="Public: anyone with the URL. Off: app members only."
              >
                <input
                  type="checkbox"
                  class="toggle toggle-xs"
                  aria-label={`Public ${env.label}`}
                  checked={env.public}
                  disabled={busy()}
                  onchange={(event) => {
                    const next = event.currentTarget.checked;
                    busy.set(true);
                    err.set("");
                    void (async () => {
                      try {
                        await updateEnvironment({
                          appId,
                          envId: env.id,
                          public: next,
                        });
                        invalidate(keys.environments(appId));
                      } catch (error) {
                        err.set(errorMessage(error));
                      }
                      busy.set(false);
                    })();
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
            {canPush ? (
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  busy.set(true);
                  err.set("");
                  void (async () => {
                    try {
                      await deployEnvironment({ appId, envId: env.id });
                      invalidate(keys.environments(appId));
                    } catch (error) {
                      err.set(errorMessage(error));
                    }
                    busy.set(false);
                  })();
                }}
              >
                <Refresh />
                Redeploy
              </button>
            ) : null}
            <button
              type="button"
              class={`btn btn-sm btn-ghost ${varsOpen() ? "btn-active" : ""}`}
              aria-expanded={varsOpen()}
              onclick={() => {
                varsOpen.set(!varsOpen());
              }}
            >
              <Key />
              Variables
            </button>
            {isAdmin ? (
              <button
                type="button"
                class="btn btn-sm btn-ghost btn-square hover:text-error"
                disabled={busy()}
                aria-label={`Delete ${env.label}`}
                title="Delete environment"
                onclick={async () => {
                  const ok = await confirmDialog({
                    confirmLabel: "Delete",
                    title: `Delete ${env.label}?`,
                  });
                  if (!ok) {
                    return;
                  }
                  busy.set(true);
                  try {
                    await deleteEnvironment({ appId, envId: env.id });
                    invalidate(keys.environments(appId));
                  } catch (error) {
                    err.set(errorMessage(error));
                  }
                  busy.set(false);
                }}
              >
                <Trash />
              </button>
            ) : null}
          </span>
        </div>
        {err() ? <p class="text-error m-0 text-xs">{err()}</p> : null}
        {varsOpen() ? (
          <div class="border-base-300 w-full border-t pt-2">
            <EnvironmentVars appId={appId} envId={env.id} myRole={myRole} />
          </div>
        ) : null}
      </div>
      {open() ? children : null}
    </section>
  );
};

/** Create environment: a branch picker; the runner derives the label. */
export const CreateEnvironmentDialog = ({
  appId,
  onCreated,
  open,
}: {
  appId: string;
  /** After the runner creates the environment (used to deep-link its group). */
  onCreated?: (env: RunnerEnvironment) => void;
  open: AtomHandle<boolean>;
}) => {
  const refs = forgeRefs(appId).data();
  const envs = environments(appId).data() ?? [];
  const branch = atom("");
  const busy = atom(false);
  const err = atom("");
  // Only branches that can get one: the default branch is the app itself, and
  // a branch already tracked by an environment has it (the runner refuses
  // both, so offering them only produces an error).
  const branches = (refs?.branches ?? []).filter(
    (one) =>
      one.name !== refs?.defaultBranch &&
      !envs.some(
        (env) =>
          env.kind === "branch" && env.gitRef === `refs/heads/${one.name}`
      )
  );
  const picked = (): string =>
    branches.some((one) => one.name === branch())
      ? branch()
      : (branches[0]?.name ?? "");
  const submit = () => {
    const target = picked();
    if (!target || busy()) {
      return;
    }
    busy.set(true);
    err.set("");
    void (async () => {
      try {
        const env = await createEnvironment({ appId, branch: target });
        invalidate(keys.environments(appId));
        open.set(false);
        if (env) {
          onCreated?.(env);
        }
      } catch (error) {
        err.set(errorMessage(error));
      }
      busy.set(false);
    })();
  };
  return (
    <Dialog open={open} class="modal">
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
          {branches.length === 0 ? (
            <p class="m-0 text-sm opacity-70">
              Every branch other than{" "}
              <span class="font-mono">{refs?.defaultBranch ?? "main"}</span>{" "}
              already has an environment. Push a new branch to create another.
            </p>
          ) : (
            <select
              id="env-branch"
              class="select select-sm w-full"
              value={picked()}
              onchange={(event) => {
                branch.set(event.currentTarget.value);
              }}
            >
              {branches.map((one) => (
                <option key={one.name} value={one.name}>
                  {one.name}
                </option>
              ))}
            </select>
          )}
        </fieldset>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={busy()}
            onclick={() => {
              open.set(false);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-sm btn-neutral"
            disabled={busy() || branches.length === 0}
            onclick={submit}
          >
            {busy() ? "Creating…" : "Create environment"}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button aria-label="Close dialog" disabled={busy()}>
          close
        </button>
      </form>
    </Dialog>
  );
};
