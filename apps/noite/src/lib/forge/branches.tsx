/** Branch UI: the compare/new-PR ref select, and the source page's branch
 * picker — a dropdown listing the branches, with the branch creator at its
 * foot (per contract: create needs `push`, delete needs `admin`). */
import { atom } from "ilha";

import { errorMessage } from "../errors";
import { collectRef, liveEl, newLiveRef } from "../live-ref";
import { appDetail } from "../resources";
import type { GitBranch } from "../runner";
import { gitBranchCreate, gitBranchDelete } from "../server/forge.server";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  GitBranch as GitBranchIcon,
  Trash,
} from "../ui/icons";
import { forgeRefs, invalidateForge } from "./data";
import { divergeLabel, shortSha } from "./format";

const SHA_RE = /^[0-9a-f]{7,40}$/u;

/** A ref's label: commits by short SHA, everything else by name. */
const refLabel = (ref: string): string =>
  SHA_RE.test(ref) ? shortSha(ref) : ref;

/** Ref select for the compare page's and the new-PR form's base/head. */
export const RefSelect = ({
  appId,
  label,
  onChange,
  value,
}: {
  appId: string;
  /** Accessible name (there is no visible label beside the select). */
  label: string;
  onChange: (ref: string) => void;
  value: string;
}) => {
  const branches = forgeRefs(appId).data()?.branches ?? [];
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
      {value !== "" && !known ? (
        <option value={value} selected>
          {refLabel(value)}
        </option>
      ) : null}
    </select>
  );
};

/** One branch in the picker: selects it, with its distance from the default
 * branch, a compare link and the admin-only delete. */
const BranchItem = ({
  appId,
  branch,
  busy,
  canDelete,
  current,
  defaultBranch,
  onDelete,
  onPick,
}: {
  appId: string;
  branch: GitBranch;
  busy: boolean;
  canDelete: boolean;
  current: boolean;
  defaultBranch: string;
  onDelete: (name: string) => void;
  onPick: (ref: string) => void;
}) => {
  const isDefault = branch.name === defaultBranch;
  const diverge = divergeLabel(branch.ahead, branch.behind);
  return (
    <li class="flex items-center gap-1">
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
      {isDefault ? null : (
        <a
          class="btn btn-ghost btn-sm btn-square"
          href={`/apps/${appId}/source/compare?base=${encodeURIComponent(defaultBranch)}&head=${encodeURIComponent(branch.name)}`}
          aria-label={`Compare ${branch.name} with ${defaultBranch}`}
          title={`Compare with ${defaultBranch}`}
        >
          <ArrowUpDown class="h-3.5 w-3.5" />
        </a>
      )}
      {canDelete && !isDefault ? (
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-square"
          disabled={busy}
          aria-label={`Delete branch ${branch.name}`}
          title="Delete branch"
          onclick={() => {
            onDelete(branch.name);
          }}
        >
          <Trash class="h-3.5 w-3.5" />
        </button>
      ) : null}
    </li>
  );
};

/** The picker's foot: a name and a button that branches off the browsed ref. */
const BranchCreator = ({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (name: string) => void;
}) => {
  const name = atom("");
  return (
    <form
      class="border-base-300 flex items-center gap-2 border-t pt-2"
      onsubmit={(event) => {
        event.preventDefault();
        const next = name().trim();
        if (next === "" || busy) {
          return;
        }
        onCreate(next);
        name.set("");
      }}
    >
      <input
        class="input input-sm min-w-0 flex-1 font-mono"
        aria-label="New branch name"
        placeholder="new-branch"
        value={name()}
        oninput={(event) => {
          name.set(event.currentTarget.value);
        }}
      />
      <button type="submit" class="btn btn-sm btn-neutral" disabled={busy}>
        Create
      </button>
    </form>
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
  const refsRes = forgeRefs(appId);
  const refs = refsRes.data();
  const role = appDetail(appId).data()?.myRole;
  const details = atom.lazy(newLiveRef<HTMLDetailsElement>)();
  const busy = atom(false);
  const failure = atom("");
  const branches = refs?.branches ?? [];
  const defaultBranch = refs?.defaultBranch ?? "main";
  const deployed = refs?.deployedSha ?? null;
  const known =
    value === deployed || branches.some((branch) => branch.name === value);

  const pick = (ref: string) => {
    const element = liveEl(details);
    if (element) {
      element.open = false;
    }
    onChange(ref);
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    busy.set(true);
    failure.set("");
    try {
      await action();
      invalidateForge(appId);
    } catch (error) {
      failure.set(errorMessage(error));
    }
    busy.set(false);
  };

  return (
    <details
      class="dropdown"
      ref={(el) => {
        collectRef(details, el);
      }}
    >
      <summary
        class="btn btn-sm max-w-64 gap-1 font-mono font-normal"
        aria-label="Branch or ref"
        title="Branch or ref"
      >
        <GitBranchIcon class="shrink-0" />
        <span class="truncate">{refLabel(value)}</span>
        <ChevronDown class="shrink-0" />
      </summary>
      <div class="dropdown-content bg-base-100 dark:bg-base-200 border-base-300 rounded-box z-50 mt-1 flex w-96 max-w-[92vw] flex-col gap-2 border p-2 shadow-lg">
        <ul class="m-0 flex max-h-80 list-none flex-col overflow-auto p-0">
          {deployed ? (
            <li>
              <button
                type="button"
                class="btn btn-ghost btn-sm w-full justify-start font-normal"
                aria-current={value === deployed ? "true" : undefined}
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
                <span class="badge badge-sm shrink-0">deployed</span>
              </button>
            </li>
          ) : null}
          {branches.map((branch) => (
            <BranchItem
              key={branch.name}
              appId={appId}
              branch={branch}
              busy={busy()}
              canDelete={role === "admin"}
              current={branch.name === value}
              defaultBranch={defaultBranch}
              onPick={pick}
              onDelete={(target) => {
                // oxlint-disable-next-line no-alert -- native confirm is the destructive-action guard used elsewhere.
                if (!confirm(`Delete branch ${target}?`)) {
                  return;
                }
                void run(async () => {
                  await gitBranchDelete({ appId, name: target });
                  if (target === value) {
                    onChange(defaultBranch);
                  }
                });
              }}
            />
          ))}
          {known ? null : (
            <li class="px-3 py-1 font-mono text-sm opacity-70">
              {refLabel(value)}
            </li>
          )}
        </ul>
        {refsRes.error() === undefined ? null : (
          <p class="text-error m-0 text-xs">Failed to load branches</p>
        )}
        {failure() ? <p class="text-error m-0 text-xs">{failure()}</p> : null}
        {role === "push" || role === "admin" ? (
          <BranchCreator
            busy={busy()}
            onCreate={(name) => {
              void run(async () => {
                await gitBranchCreate({
                  appId,
                  from: value,
                  name,
                });
                pick(name);
              });
            }}
          />
        ) : null}
      </div>
    </details>
  );
};
