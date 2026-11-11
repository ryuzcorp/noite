/** The source page's Changes panel: every unsaved change as a diff or a row,
 * the discard behind each of them, and the commit form under it (message,
 * target branch, Push). The buffers live in the page's editor session; this
 * reads the state the browser reports and asks it to commit or throw away. */
import { Link } from "@ilha/void";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { formatBytes } from "../bytes";
import { DraftDiffView } from "../forge/diff";
import type { GitBranch } from "../runner";
import { confirmDialog } from "../ui/confirm";
import {
  choiceOf,
  CommitChoices,
  NEW_BRANCH,
  planNotice,
  planTarget,
  selectValue,
} from "./commit-target";
import type { CommitChoice } from "./commit-target";
import type { CommitDrafts, PushRequest, SourceBrowserState } from "./drafts";
import { pushErrorCopy, READ_ONLY_PUSH } from "./failure-copy";
import {
  rowBadge,
  rowBytes,
  rowDiffed,
  rowDiscardable,
  rowLabel,
  rowUndoable,
  rowView,
} from "./row-view";
import type { ChangeKind, SourceChange } from "./session";

/** The commit targets, in the select's order: the browsed ref first (the
 * default target), then the default branch, then every other branch
 * newest-first. A ref that is not a branch (a tag or a commit) has no row in
 * `branches` and still leads. */
const commitTargets = (
  branches: readonly GitBranch[],
  browsed: string,
  defaultBranch: string
): string[] => {
  const names = branches.map((branch) => branch.name);
  const head = [browsed];

  if (defaultBranch !== browsed && names.includes(defaultBranch)) {
    head.push(defaultBranch);
  }

  return [
    ...head,
    ...branches
      .filter(
        (branch) => branch.name !== browsed && branch.name !== defaultBranch
      )
      .toSorted((a, b) => b.committedAt - a.committedAt)
      .map((branch) => branch.name),
  ];
};

/** The verb a change's kind contributes to the default message. A move reads
 * as "Rename": the path changed, whatever the bytes did. */
const KIND_VERBS: Record<ChangeKind, string> = {
  added: "Add",
  deleted: "Delete",
  modified: "Update",
  moved: "Rename",
};

/** The verb of one change: a new binary file is an upload, not an add. */
const changeVerb = (file: SourceChange): string =>
  file.bytes !== undefined && file.kind === "added"
    ? "Upload"
    : KIND_VERBS[file.kind];

/** The commit message when the field is left empty. A single file reads
 * "<Verb> <basename>" so History is not a wall of identical subjects; a set of
 * changes sharing one verb reads "<Verb> N files", and a mixed one "Update N
 * files". */
const defaultMessage = (state: SourceBrowserState): string => {
  const { files } = state;

  if (files.length === 0) {
    return "Update files";
  }

  if (files.length === 1) {
    const [file] = files;

    return `${changeVerb(file)} ${file.path.slice(file.path.lastIndexOf("/") + 1)}`;
  }

  const [first] = files;
  const verb = first === undefined ? "" : changeVerb(first);

  return files.every((file) => changeVerb(file) === verb)
    ? `${verb} ${files.length} files`
    : `Update ${files.length} files`;
};

/** The outcome line under the form: the error, or where the push landed
 * (with the pull-request shortcut after a push to a new branch). */
const PushOutcome = ({
  appId,
  state,
  title,
}: {
  appId: string;
  state: SourceBrowserState;
  title: string;
}) => {
  if (state.pushError !== null) {
    return (
      <p class="text-error m-0 text-xs" role="alert">
        {pushErrorCopy(state.pushError)}
      </p>
    );
  }

  const { pushed } = state;

  if (!pushed) {
    return null;
  }

  if (!pushed.newBranch) {
    return (
      <p class="m-0 text-xs opacity-70">
        Pushed to <span class="font-mono">{pushed.branch}</span>.
      </p>
    );
  }

  return (
    <p class="m-0 text-xs opacity-70">
      Pushed to <span class="font-mono">{pushed.branch}</span>.{" "}
      <Link
        class="link"
        href={`/apps/${appId}/pulls/new?base=${encodeURIComponent(pushed.base)}&head=${encodeURIComponent(pushed.branch)}&title=${encodeURIComponent(title)}`}
      >
        Open a pull
      </Link>
    </p>
  );
};

/** The choice the user made, with the ref it was made on. This form's fiber
 * survives a ref switch (the Changes tab keeps what it holds), so the ref is
 * part of the state: a target left over from the branch the user came from
 * would commit to *that* branch. */
interface HeldChoice {
  branch: string;
  choice: CommitChoice;
}

/** Message, target branch and Push. */
const CommitForm = ({
  appId,
  branch,
  branches,
  commit,
  defaultBranch,
  isProtected,
  state,
}: {
  appId: string;
  /** The branch being browsed: where the commit goes by default. */
  branch: string;
  /** The app's branches, as the target select lists them (the browsed ref may
   * be a tag or a commit, which has no row there). */
  branches: readonly GitBranch[];
  commit: CommitDrafts;
  /** The app's default branch: the one branch protection covers. */
  defaultBranch: string;
  /** Whether a branch refuses a direct commit (see `./push-target`). */
  isProtected: (branch: string) => boolean;
  state: AtomHandle<SourceBrowserState>;
}) => {
  const message = atom("");

  /** What the user picked, and on which ref (see `HeldChoice`). */
  const choice = atom<HeldChoice>({
    branch,
    choice: CommitChoices.Browsed(),
  });

  // The title the pull-request shortcut prefills: the last pushed message.
  const lastMessage = atom("");
  const current = state();
  const held = choice();

  // What the form shows: the choice made on this ref, or the fresh one a switch
  // to another ref starts from (the browsed branch itself).
  const mine: CommitChoice =
    held.branch === branch ? held.choice : CommitChoices.Browsed();

  const targets = commitTargets(branches, branch, defaultBranch);

  // What the push would do: protection re-targets the browsed branch to a new
  // one, and the name rules decide whether that can go (see `./commit-target`).
  const plan = planTarget(mine, branch, isProtected, current.files.length > 0);

  const notice = planNotice(mine, plan);

  // The select's value: the browsed branch itself for the default choice (so
  // the first option stays selected), and the sentinel/target otherwise.
  const into =
    plan.choice._tag === "Browsed" ? branch : selectValue(plan.choice);

  const blocked = plan.blocked || current.pushing;

  const newName = plan.choice._tag === "New" ? plan.choice.name : "";

  return (
    <form
      class="border-base-300 flex flex-col gap-2 border-t px-3 py-3"
      onsubmit={(event) => {
        event.preventDefault();

        if (blocked) {
          return;
        }

        const text = message().trim() || defaultMessage(current);
        const request: PushRequest = { message: text };

        // `Browsed` names no branch (the runner's default is the one being
        // browsed); a new branch names itself and the runner creates it at the
        // browsed tip; any other target names its branch, which the runner
        // grows from its own tip.
        if (plan.branch !== undefined) {
          request.branch = plan.branch;
        }

        lastMessage.set(text);

        void (async () => {
          // A landed push empties the form for the next commit; a failed one
          // keeps it for the retry. Only this ref's choice is cleared — a
          // switch mid-push has its own.
          if (await commit(request)) {
            message.set("");

            if (held.branch === branch) {
              // A landed push empties the new branch's name for the next
              // commit; the target itself stays where the user put it.
              choice.set({
                branch,
                choice:
                  plan.choice._tag === "New"
                    ? CommitChoices.New({ name: "" })
                    : plan.choice,
              });
            }
          }
        })();
      }}
    >
      <input
        class="input input-sm w-full"
        aria-label="Commit message"
        placeholder={
          current.files.length > 0 ? defaultMessage(current) : "Commit message"
        }
        value={message()}
        oninput={(event) => {
          message.set(event.currentTarget.value);
        }}
      />
      <div class="flex items-center gap-2">
        <select
          class="select select-sm min-w-0 flex-1"
          aria-label="Commit to"
          value={into}
          onchange={(event) => {
            const { value } = event.currentTarget;
            // Picking "New branch…" again keeps the name already typed.
            choice.set({
              branch,
              choice:
                value === NEW_BRANCH && mine._tag === "New"
                  ? mine
                  : choiceOf(value, branch),
            });
          }}
        >
          {targets.map((name) => (
            <option
              key={name}
              value={name}
              selected={into === name}
              disabled={isProtected(name)}
            >
              {isProtected(name) ? `${name} (protected)` : name}
            </option>
          ))}
          <option
            key={NEW_BRANCH}
            value={NEW_BRANCH}
            selected={into === NEW_BRANCH}
          >
            New branch…
          </option>
        </select>
        <button type="submit" class="btn btn-sm btn-neutral" disabled={blocked}>
          {current.pushing ? "Pushing…" : "Push"}
        </button>
      </div>
      {notice === "" ? null : (
        <p class="m-0 text-xs opacity-70" role="status">
          {notice}
        </p>
      )}
      {plan.choice._tag === "New" ? (
        <>
          <input
            class="input input-sm w-full font-mono"
            aria-label="New branch name"
            aria-invalid={plan.reason === "" ? undefined : "true"}
            placeholder="my-change"
            value={newName}
            oninput={(event) => {
              choice.set({
                branch,
                choice: CommitChoices.New({ name: event.currentTarget.value }),
              });
            }}
          />
          {plan.reason === "" ? null : (
            <p class="text-error m-0 text-xs" role="alert">
              {plan.reason}
            </p>
          )}
        </>
      ) : null}
      <PushOutcome appId={appId} state={current} title={lastMessage()} />
    </form>
  );
};

export interface ChangesPanelProps {
  appId: string;
  /** The branch being browsed: the commit target by default, and the base the
   * pull-request shortcut points at. */
  branch: string;
  /** The app's branches, as the commit target select lists them. */
  branches: readonly GitBranch[];
  commit: CommitDrafts;
  /** The app's default branch: the one branch protection covers. */
  defaultBranch: string;
  /** Throw one row's change away (the panel has asked first). */
  discard: (path: string) => void;
  /** Throw every change away, back to the last commit (asked first). */
  discardAll: () => void;
  /** Whether a branch refuses a direct commit — `require_pr` on, the caller
   * below admin, the default branch (see `./push-target`): the select disables
   * it and the commit goes to a new branch instead. */
  isProtected: (branch: string) => boolean;
  /** Undo of a deletion draft or a move — the file returns to the tree. */
  restore: (path: string) => void;
  state: AtomHandle<SourceBrowserState>;
}

/** One change: what it is, where it sits, and what can be done with it. An
 * upload shows its size where a diff would be — there is no text to compare.
 * `last` drops the divider (passed, not `last:`: a component's root sits in
 * its own wrapper, so `last:` would match every row). */
const ChangeRow = ({
  file,
  last,
  onDiscard,
  restore,
}: {
  file: SourceChange;
  last: boolean;
  onDiscard: (file: SourceChange) => void;
  restore: (path: string) => void;
}) => {
  const row = rowView(file);
  const badge = rowBadge(row);
  const bytes = rowBytes(row);

  return (
    <li
      class={`border-base-300 flex items-center gap-2 px-3 py-2 ${last ? "" : "border-b"}`}
    >
      <span class={`badge badge-sm ${badge.class}`}>{badge.label}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-xs">
        {rowLabel(row)}
        {bytes === null ? null : ` · ${formatBytes(bytes)}`}
      </span>
      {rowDiscardable(row) ? (
        <button
          type="button"
          class="btn btn-xs btn-ghost hover:bg-error/10 hover:text-error"
          aria-label={`Discard changes to ${file.path}`}
          onclick={() => {
            onDiscard(file);
          }}
        >
          Discard
        </button>
      ) : null}
      {rowUndoable(row) ? (
        <button
          type="button"
          class="btn btn-xs btn-neutral"
          aria-label={`Restore ${file.path}`}
          onclick={() => {
            restore(file.path);
          }}
        >
          Restore
        </button>
      ) : null}
    </li>
  );
};

/** Every change: what the push would write (the diffs), then one row per
 * change with its discard and undo, then the commit form. */
export const ChangesPanel = ({
  appId,
  branch,
  branches,
  commit,
  defaultBranch,
  discard,
  discardAll,
  isProtected,
  restore,
  state,
}: ChangesPanelProps) => {
  const { files, readOnly, revision } = state();

  // One controller per mounted panel: a dialog left open by a close is torn
  // down with it instead of blocking the page.
  // A live controller does not survive the SSR snapshot: out of it, so the
  // client builds its own on hydration.
  const dialogs = atom.lazy(() => new AbortController(), {
    snapshot: false,
  })();

  watch.once(({ onCleanup }) => {
    onCleanup(() => {
      dialogs.abort();
    });
  });

  // Text changes carry a diff; an upload has no text to compare, and a pure
  // move or a staged deletion has none either.
  const diffed = files
    .filter((file) => rowDiffed(rowView(file)))
    .map((file) => ({
      after: file.after,
      before: file.before ?? "",
      path: file.path,
    }));

  const ask = (title: string, message: string, confirmLabel: string) =>
    confirmDialog({
      confirmLabel,
      message,
      signal: dialogs.signal,
      title,
    });

  const askDiscard = (file: SourceChange) => {
    void (async () => {
      const ok = await ask(
        `Discard changes to ${file.path}?`,
        "The file goes back to the last commit.",
        "Discard"
      );

      if (ok === "confirm") {
        discard(file.path);
      }
    })();
  };

  const askDiscardAll = () => {
    void (async () => {
      const ok = await ask(
        "Discard all changes?",
        `All ${files.length} changes go back to the last commit.`,
        "Discard all"
      );

      if (ok === "confirm") {
        discardAll();
      }
    })();
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-auto">
        {files.length === 0 ? (
          <p class="m-0 px-3 py-3 text-sm opacity-70">
            {readOnly === "" ? (
              <>
                No changes. Edits to files on{" "}
                <span class="font-mono">{branch}</span> show up here.
              </>
            ) : (
              READ_ONLY_PUSH[readOnly]
            )}
          </p>
        ) : (
          <div class="flex flex-col">
            <div class="border-base-300 flex items-center gap-2 border-b px-3 py-2">
              <span class="flex-1 text-xs opacity-70">
                {files.length} changed {files.length === 1 ? "file" : "files"}
              </span>
              <button
                type="button"
                class="btn btn-xs btn-ghost hover:bg-error/10 hover:text-error"
                onclick={askDiscardAll}
              >
                Discard all
              </button>
            </div>
            {diffed.length === 0 ? null : (
              <DraftDiffView
                key={`drafts:${revision}`}
                emptyLabel="No changes."
                files={diffed}
              />
            )}
            <ul
              class="border-base-300 m-0 flex list-none flex-col border-t p-0"
              aria-label="Changed files"
              role="list"
            >
              {files.map((file, index) => (
                <ChangeRow
                  key={file.path}
                  file={file}
                  last={index === files.length - 1}
                  onDiscard={askDiscard}
                  restore={restore}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
      {readOnly === "" ? (
        <CommitForm
          appId={appId}
          branch={branch}
          branches={branches}
          commit={commit}
          defaultBranch={defaultBranch}
          isProtected={isProtected}
          state={state}
        />
      ) : null}
    </div>
  );
};
