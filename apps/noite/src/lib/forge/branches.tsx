import { Link, useRouter } from "@ilha/void";
import { atom } from "ilha";

import { api } from "../api";
import { errorMessage } from "../errors";
import { collectRef, liveEl, newLiveRef } from "../live-ref";
import { resourceValue, resourceError } from "../resource";
/** Branch UI: the compare/new-PR ref select, and the source page's branch
 * picker — a dropdown listing the branches, with the branch creator at its
 * foot (per contract: create needs `push`, delete needs `admin`). */
import { appDetail, environments, invalidate, keys } from "../resources";
import type { GitBranch, RunnerEnvironment } from "../runner";
import { confirmDialog } from "../ui/confirm";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  GitBranch as GitBranchIcon,
  Monitor,
  Trash,
} from "../ui/icons";
import { branchNameError } from "./branch-name";
import { forgeRefs, invalidateForge } from "./data";
import { divergeLabel, shortSha } from "./format";
import {
  failAction,
  pickerBusy,
  pickerError,
  PickerStates,
  reopenPicker,
  settleAction,
  startAction,
} from "./picker-state";
import type { PickerAction, PickerState } from "./picker-state";

const SHA_RE = /^[0-9a-f]{7,40}$/u;

/** The per-branch icon buttons: a square ghost button, aligned with its
 * neighbours and revealed on the row's hover or focus (always visible where
 * there is no pointer to hover with). */
const ROW_ACTION =
  "btn btn-ghost btn-sm btn-square opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100";

/** A ref's label: commits by short SHA, everything else by name. */
const refLabel = (ref: string): string =>
  SHA_RE.test(ref) ? shortSha(ref) : ref;

/** Arrow-key movement through the picker's rows (a plain list of buttons and
 * links, not a listbox: the list also holds the read-only deployed sha and an
 * unknown ref, which are not selectable options). */
const moveBranchFocus = (event: KeyboardEvent): void => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }

  const list = event.currentTarget;

  if (!(list instanceof HTMLElement)) {
    return;
  }

  const items = [
    ...list.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"),
  ];

  if (items.length === 0) {
    return;
  }

  event.preventDefault();
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = index === -1 ? 0 : (index + step + items.length) % items.length;
  items[next]?.focus();
};

/** Ref select for the compare page's and the new-PR form's base/head. */
export const RefSelect = ({
  appId,
  label,
  onChange,
  value,
}: {
  appId: string;
  /** Accessible name; the visible caption beside the select is `RefField`'s
   * (the two match, so voice control and the screen reader agree). */
  label: string;
  onChange: (ref: string) => void;
  value: string;
}) => {
  const refs = resourceValue(forgeRefs(appId).state());
  const branches = refs?.branches ?? [];
  const known = branches.some((branch) => branch.name === value);

  return (
    <select
      class="select select-sm max-w-56"
      aria-label={label}
      value={value}
      onchange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      {branches.map((branch) => (
        <option
          key={branch.name}
          value={branch.name}
          selected={branch.name === value}
        >
          {branch.name}
        </option>
      ))}
      {/* Only once the refs are in: the whole option set then arrives in one
       * paint. An extra option rendered before them would be the select's only
       * child, and ilha's morph reuses an unkeyed child positionally — it
       * would keep this option's `value` over the first branch's name. */}
      {refs !== undefined && value !== "" && !known ? (
        <option key="ref" value={value} selected>
          {refLabel(value)}
        </option>
      ) : null}
    </select>
  );
};

/** One branch picker with the caption a pilot needs: the select's accessible
 * name alone left two identical-looking dropdowns ("main",
 * "feature/checkout") with nothing saying which is base and which is head. The
 * visible caption matches the accessible name, so voice control and the screen
 * reader say the same word. */
export const RefField = ({
  caption,
  ...props
}: { caption: string } & Omit<Parameters<typeof RefSelect>[0], "label">) => (
  <label class="flex min-w-0 flex-col gap-1">
    <span class="text-base-content/60 text-xs">{caption}</span>
    <RefSelect {...props} label={caption} />
  </label>
);

/** One branch in the picker: selects it, with its distance from the default
 * branch, a compare link, the push-only create-environment action and the
 * admin-only delete. */
const BranchItem = ({
  appId,
  branch,
  browsed,
  busy,
  canDelete,
  canEnv,
  current,
  defaultBranch,
  envId,
  onDelete,
  onEnvironment,
  onPick,
}: {
  appId: string;
  branch: GitBranch;
  /** The ref the picker is browsing; the compare link carries it so the
   * compare page's back link returns to it. */
  browsed: string;
  busy: boolean;
  canDelete: boolean;
  canEnv: boolean;
  current: boolean;
  defaultBranch: string;
  /** The environment already tracking this branch, if any. */
  envId: string | null;
  onDelete: (name: string) => void;
  onEnvironment: (name: string) => void;
  onPick: (ref: string) => void;
}) => {
  const isDefault = branch.name === defaultBranch;
  const diverge = divergeLabel(branch.ahead, branch.behind);

  return (
    <li class="group flex items-center gap-1">
      <button
        type="button"
        class="btn btn-ghost btn-sm min-w-0 flex-1 justify-start font-normal"
        aria-current={current ? "true" : undefined}
        title={branch.subject}
        onclick={() => {
          onPick(branch.name);
        }}
      >
        <Check class={`h-3.5 w-3.5 shrink-0 ${current ? "" : "invisible"}`} />
        <span class="min-w-0 flex-1 truncate text-left font-mono">
          {branch.name}
        </span>
        {isDefault ? (
          <span class="badge badge-sm shrink-0">default</span>
        ) : null}
        {diverge ? (
          <span class="shrink-0 text-xs opacity-60">{diverge}</span>
        ) : null}
      </button>
      <span class="flex shrink-0 items-center gap-1">
        {isDefault ? null : (
          <Link
            class={ROW_ACTION}
            href={`/apps/${appId}/source/compare?base=${encodeURIComponent(defaultBranch)}&head=${encodeURIComponent(branch.name)}&ref=${encodeURIComponent(browsed)}`}
            aria-label={`Compare ${branch.name} with ${defaultBranch}`}
            title={`Compare ${branch.name} with ${defaultBranch}`}
          >
            <ArrowUpDown class="h-3.5 w-3.5" />
          </Link>
        )}
        {canDelete && !isDefault ? (
          <button
            type="button"
            class={ROW_ACTION}
            disabled={busy}
            aria-label={`Delete branch ${branch.name}`}
            title={`Delete ${branch.name}`}
            onclick={() => {
              onDelete(branch.name);
            }}
          >
            <Trash class="h-3.5 w-3.5" />
          </button>
        ) : null}
        {canEnv && !isDefault && envId !== null ? (
          <Link
            class={ROW_ACTION}
            href={`/apps/${appId}?t=deployments&env=${envId}`}
            aria-label={`Open the ${branch.name} environment`}
            title={`Open the ${branch.name} environment`}
          >
            <Monitor class="h-3.5 w-3.5" />
          </Link>
        ) : null}
        {canEnv && !isDefault && envId === null ? (
          <button
            type="button"
            class={ROW_ACTION}
            disabled={busy}
            aria-label={`Create environment for ${branch.name}`}
            title={`Create an environment for ${branch.name}`}
            onclick={() => {
              onEnvironment(branch.name);
            }}
          >
            <Monitor class="h-3.5 w-3.5" />
          </button>
        ) : null}
      </span>
    </li>
  );
};

/** The picker's foot: a name and a button that branches off the browsed ref.
 * The name is checked against the runner's own rules before the request, so a
 * bad one is refused here with a reason instead of as a server error. */
const BranchCreator = ({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (name: string) => void;
}) => {
  const name = atom("");
  const next = name().trim();
  const invalid = next === "" ? null : branchNameError(next);

  return (
    <div class="border-base-300 flex flex-col gap-1 border-t pt-2">
      <form
        class="flex items-center gap-2"
        onsubmit={(event) => {
          event.preventDefault();

          if (next === "" || busy || invalid !== null) {
            return;
          }

          onCreate(next);
          name.set("");
        }}
      >
        <input
          class="input input-sm min-w-0 flex-1 font-mono"
          aria-label="New branch name"
          aria-invalid={invalid === null ? undefined : "true"}
          aria-describedby={invalid === null ? undefined : "new-branch-error"}
          placeholder="new-branch"
          value={name()}
          oninput={(event) => {
            name.set(event.currentTarget.value);
          }}
        />
        <button
          type="submit"
          class="btn btn-sm btn-neutral"
          disabled={busy || invalid !== null}
        >
          Create
        </button>
      </form>
      {invalid === null ? null : (
        <p id="new-branch-error" class="text-error m-0 text-xs">
          {invalid}
        </p>
      )}
    </div>
  );
};

/** The source page's branch picker. `value` is the browsed ref (the default
 * branch unless picked otherwise); the deployed commit has its own row, and
 * creating a branch switches to it. */
export const BranchPicker = ({
  appId,
  onChange,
  value,
}: {
  appId: string;
  onChange: (ref: string) => void;
  value: string;
}) => {
  const router = useRouter();
  const refsRes = forgeRefs(appId);
  const refs = resourceValue(refsRes.state());
  const role = resourceValue(appDetail(appId).state())?.myRole;
  const details = atom.lazy(newLiveRef<HTMLDetailsElement>)();
  // The dropdown's open state lives on the element alone: `data-morph-preserve`
  // keeps ilha's morph off the `open` attribute, which a render does not name.
  // Without it an ancestor's repaint — the source page repaints on every draft
  // report and every switch — closed a dropdown the user had just opened, and
  // a render-held copy of the state reopened one `pick` had just closed.
  /** The picker's one action slot (see `./picker-state`): the failure it
   * shows belongs to the gesture that made it, and a second click cannot
   * stack a second confirm. */
  const picker = atom<PickerState>(PickerStates.Idle());
  const branches = refs?.branches ?? [];
  const defaultBranch = refs?.defaultBranch ?? "main";
  const deployed = refs?.deployedSha ?? null;
  const envs = resourceValue(environments(appId).state()) ?? [];

  const known =
    value === deployed || branches.some((branch) => branch.name === value);

  const pick = (ref: string) => {
    const element = liveEl(details);

    if (element) {
      element.open = false;
    }

    picker.set(reopenPicker(picker()));
    onChange(ref);
  };

  /** Run one mutation, refused while another (or its confirm) is running. */
  const run = async (
    action: PickerAction,
    ref: string,
    work: () => Promise<void>
  ): Promise<boolean> => {
    const before = picker();

    if (before._tag === "Busy") {
      return false;
    }

    picker.set(startAction(before, action, ref));

    try {
      await work();
      invalidateForge(appId);
    } catch (error) {
      picker.set(failAction(picker(), errorMessage(error)));

      return false;
    }

    picker.set(settleAction(picker()));

    return true;
  };

  return (
    <details
      class="dropdown"
      data-morph-preserve="open"
      ref={(el) => {
        collectRef(details, el);
      }}
      ontoggle={(event) => {
        if (event.currentTarget.open) {
          picker.set(reopenPicker(picker()));
        }
      }}
    >
      <summary
        class={`btn btn-sm max-w-64 gap-1 font-mono font-normal ${resourceError(refsRes.state()) === undefined ? "" : "border-error text-error"}`}
        aria-label={`Branch or ref: ${refLabel(value)}`}
        title={`Branch: ${refLabel(value)}`}
      >
        <GitBranchIcon class="shrink-0" />
        <span class="truncate">{refLabel(value)}</span>
        <ChevronDown class="shrink-0" />
      </summary>
      <div class="dropdown-content bg-base-100 dark:bg-base-200 border-base-300 rounded-box z-50 mt-1 flex w-96 max-w-[92vw] flex-col gap-2 border p-2 shadow-lg">
        <ul
          class="m-0 flex max-h-80 list-none flex-col overflow-auto p-0"
          aria-label="Branches and refs"
          onkeydown={moveBranchFocus}
        >
          {deployed ? (
            <li>
              <button
                type="button"
                class="btn btn-ghost btn-sm w-full justify-start font-normal"
                aria-current={value === deployed ? "true" : undefined}
                title="The commit production is serving (read-only)"
                onclick={() => {
                  pick(deployed);
                }}
              >
                <Check
                  class={`h-3.5 w-3.5 shrink-0 ${value === deployed ? "" : "invisible"}`}
                />
                <span class="min-w-0 flex-1 truncate text-left font-mono">
                  {shortSha(deployed)}
                </span>
                <span class="badge badge-sm shrink-0">Production deploy</span>
              </button>
            </li>
          ) : null}
          {branches.map((branch) => (
            <BranchItem
              key={branch.name}
              appId={appId}
              branch={branch}
              browsed={value}
              busy={pickerBusy(picker())}
              canDelete={role === "admin"}
              canEnv={role === "push" || role === "admin"}
              current={branch.name === value}
              defaultBranch={defaultBranch}
              envId={
                envs.find((env) => env.gitRef === `refs/heads/${branch.name}`)
                  ?.id ?? null
              }
              onPick={pick}
              onEnvironment={(target) => {
                void run("environment", target, async () => {
                  const env = await api<RunnerEnvironment | null>(
                    "/api/environments/createEnvironment",
                    {
                      appId,
                      branch: target,
                    }
                  );

                  invalidate(keys.environments(appId));
                  router.visit(
                    env
                      ? `/apps/${appId}?t=deployments&env=${env.id}`
                      : `/apps/${appId}?t=deployments`
                  );
                });
              }}
              onDelete={(target) => {
                void (async () => {
                  if (picker()._tag === "Busy") {
                    return;
                  }

                  picker.set(startAction(picker(), "delete-confirm", target));

                  const tracked = envs.find(
                    (env) => env.gitRef === `refs/heads/${target}`
                  );

                  const lines = [`Deleting ${target} is permanent.`];

                  if (tracked) {
                    lines.push(
                      "Its preview environment, and that environment's own data, are deleted too."
                    );
                  }

                  lines.push(
                    "Any open pull request from this branch loses its head."
                  );

                  const ok = await confirmDialog({
                    confirmLabel: "Delete",
                    message: lines.join(" "),
                    title: `Delete branch ${target}?`,
                  });

                  if (ok !== "confirm") {
                    picker.set(settleAction(picker()));

                    return;
                  }

                  await run("delete", target, async () => {
                    await api<{ ok: true }>("/api/forge/gitBranchDelete", {
                      appId,
                      name: target,
                    });

                    if (target === value) {
                      onChange(defaultBranch);
                    }
                  });
                })();
              }}
            />
          ))}
          {known ? null : (
            <li class="px-3 py-1 font-mono text-sm opacity-70">
              {refLabel(value)}
            </li>
          )}
        </ul>
        {resourceError(refsRes.state()) === undefined ? null : (
          <p class="text-error m-0 flex items-center gap-2 text-xs">
            Failed to load branches
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              onclick={() => {
                void refsRes.refetch();
              }}
            >
              Retry
            </button>
          </p>
        )}
        {pickerError(picker()) === "" ? null : (
          <p class="text-error m-0 text-xs">{pickerError(picker())}</p>
        )}
        {role === "push" || role === "admin" ? (
          <BranchCreator
            busy={pickerBusy(picker())}
            onCreate={(name) => {
              void (async () => {
                // The switch waits for `run`, and with it for the invalidation:
                // whether the new ref opens editable is read off the refs list
                // (see `canEditRef` in the source page), and only the next read
                // of that list holds the branch this just created.
                const created = await run("create", name, async () => {
                  await api<{ ok: true }>("/api/forge/gitBranchCreate", {
                    appId,
                    from: value,
                    name,
                  });
                });

                if (created) {
                  pick(name);
                }
              })();
            }}
          />
        ) : null}
      </div>
    </details>
  );
};
