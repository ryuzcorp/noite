/** The source page's Changes panel: every unpushed change as a diff or a row,
 * the discard behind each of them, and the commit form under it (message,
 * target branch, Push). The drafts live in the browser; this reads the state
 * it reports and asks it to commit or throw away. */
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { formatBytes } from "../bytes";
import { DraftDiffView } from "../forge/diff";
import { confirmDialog } from "../ui/confirm";
import type { CommitDrafts, PushRequest, SourceBrowserState } from "./drafts";
import type { WorkspaceChange } from "./workspace/types";

/** Where the commit goes: the default branch, or a new branch off its tip. */
type Target = "default" | "new";

/** The commit message when the field is left empty. */
const defaultMessage = (state: SourceBrowserState): string =>
  `Web edit: ${state.files.map((file) => file.path).join(", ")}`;

/** The outcome line under the form: the error, or where the push landed
 * (with the pull-request shortcut after a push to a new branch). */
const PushOutcome = ({
  appId,
  defaultBranch,
  state,
  title,
}: {
  appId: string;
  defaultBranch: string;
  state: SourceBrowserState;
  title: string;
}) => {
  if (state.pushError !== "") {
    return <p class="text-error m-0 text-xs">{state.pushError}</p>;
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
      <a
        class="link"
        href={`/apps/${appId}/pulls/new?base=${encodeURIComponent(defaultBranch)}&head=${encodeURIComponent(pushed.branch)}&title=${encodeURIComponent(title)}`}
      >
        Open a pull
      </a>
    </p>
  );
};

/** Message, target branch and Push. */
const CommitForm = ({
  appId,
  commit,
  defaultBranch,
  protectedMain,
  state,
}: {
  appId: string;
  commit: CommitDrafts;
  defaultBranch: string;
  protectedMain: boolean;
  state: AtomHandle<SourceBrowserState>;
}) => {
  const message = atom("");
  const target = atom<Target>("default");
  const branchName = atom("");
  // The title the pull-request shortcut prefills: the last pushed message.
  const lastMessage = atom("");
  const current = state();
  // A protected default branch only takes commits through a pull.
  const into: Target = protectedMain ? "new" : target();
  const branch = branchName().trim();
  const blocked =
    current.files.length === 0 ||
    current.pushing ||
    (into === "new" && branch === "");
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
        if (into === "new") {
          request.branch = branch;
        }
        lastMessage.set(text);
        void (async () => {
          // A landed push empties the form for the next commit; a failed one
          // keeps it for the retry.
          if (await commit(request)) {
            message.set("");
            branchName.set("");
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
            target.set(event.currentTarget.value === "new" ? "new" : "default");
          }}
        >
          <option
            value="default"
            selected={into === "default"}
            disabled={protectedMain}
          >
            {protectedMain ? `${defaultBranch} (protected)` : defaultBranch}
          </option>
          <option value="new" selected={into === "new"}>
            New branch…
          </option>
        </select>
        <button type="submit" class="btn btn-sm btn-neutral" disabled={blocked}>
          {current.pushing ? "Pushing…" : "Push"}
        </button>
      </div>
      {into === "new" ? (
        <input
          class="input input-sm w-full font-mono"
          aria-label="New branch name"
          placeholder="my-change"
          value={branchName()}
          oninput={(event) => {
            branchName.set(event.currentTarget.value);
          }}
        />
      ) : null}
      <PushOutcome
        appId={appId}
        defaultBranch={defaultBranch}
        state={current}
        title={lastMessage()}
      />
    </form>
  );
};

export interface ChangesPanelProps {
  appId: string;
  commit: CommitDrafts;
  defaultBranch: string;
  /** Throw one row's change away (the panel has asked first). */
  discard: (path: string) => void;
  /** Throw every change away, back to the last commit (asked first). */
  discardAll: () => void;
  /** `require_pr` on and the caller below admin: new branches only. */
  protectedMain: boolean;
  /** Undo of a deletion draft — the file returns to the tree. */
  restore: (path: string) => void;
  state: AtomHandle<SourceBrowserState>;
}

/** What a row reads as: a move shows both paths. */
const rowLabel = (file: WorkspaceChange): string =>
  file.kind === "moved" && file.movedFrom !== undefined
    ? `${file.movedFrom} → ${file.path}`
    : file.path;

/** Whether the row has an edit to throw away: a pure move and a staged
 * deletion have nothing but the move or the deletion to undo. */
const hasEdit = (file: WorkspaceChange): boolean =>
  file.binary !== undefined || file.after !== file.before;

/** The badge a row shows: what the change is, and the daisyUI tone for it. */
interface RowBadge {
  class: string;
  label: string;
}

/** The little daisyUI badge that says what a row is. Added, modified and
 * binary stay neutral (the app's own tone); the two destructive shapes carry
 * their colour. */
const rowBadge = (file: WorkspaceChange): RowBadge => {
  if (file.binary !== undefined) {
    return { class: "badge-neutral", label: "binary" };
  }
  if (file.kind === "deleted") {
    return { class: "badge-error", label: "deleted" };
  }
  if (file.kind === "moved") {
    return { class: "badge-warning", label: "moved" };
  }
  return { class: "badge-neutral", label: file.kind };
};

/** One change: what it is, where it sits, and what can be done with it. An
 * upload shows its size where a diff would be — there is no text to compare. */
const ChangeRow = ({
  file,
  onDiscard,
  restore,
}: {
  file: WorkspaceChange;
  onDiscard: (file: WorkspaceChange) => void;
  restore: (path: string) => void;
}) => {
  const badge = rowBadge(file);
  const undoing = file.kind === "deleted" || file.kind === "moved";
  return (
    <li class="border-base-300 flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <span class={`badge badge-sm ${badge.class}`}>{badge.label}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-xs">
        {rowLabel(file)}
        {file.binary === undefined ? null : ` · ${formatBytes(file.binary)}`}
      </span>
      {file.loading ? (
        <span
          class="loading loading-xs"
          title="Reading the committed copy"
        ></span>
      ) : null}
      {file.kind === "deleted" ||
      (file.kind === "moved" && !hasEdit(file)) ? null : (
        <button
          type="button"
          class="btn btn-xs btn-neutral"
          aria-label={`Discard changes to ${file.path}`}
          onclick={() => {
            onDiscard(file);
          }}
        >
          Discard
        </button>
      )}
      {undoing ? (
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
  commit,
  defaultBranch,
  discard,
  discardAll,
  protectedMain,
  restore,
  state,
}: ChangesPanelProps) => {
  const { files, revision, stale } = state();
  // One controller per mounted panel: a dialog left open by a close is torn
  // down with it instead of blocking the page.
  const dialogs = atom.lazy(() => new AbortController())();
  watch.once(({ onCleanup }) => {
    onCleanup(() => {
      dialogs.abort();
    });
  });
  // Text changes carry a diff; an upload has no text to compare, a pure move
  // or a staged deletion has none either, and a row whose committed text is
  // still being read has nothing to compare against yet.
  const diffed = files.filter(
    (file) =>
      !file.loading &&
      file.binary === undefined &&
      file.kind !== "deleted" &&
      (file.kind !== "moved" || hasEdit(file))
  );
  const ask = (title: string, message: string, confirmLabel: string) =>
    confirmDialog({
      confirmLabel,
      message,
      signal: dialogs.signal,
      title,
    });
  const askDiscard = (file: WorkspaceChange) => {
    void (async () => {
      const ok = await ask(
        `Discard changes to ${file.path}?`,
        "The file goes back to the last commit.",
        "Discard"
      );
      if (ok) {
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
      if (ok) {
        discardAll();
      }
    })();
  };
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {stale === null ? null : (
        <p
          class="bg-warning/20 text-base-content border-base-300 m-0 border-b px-3 py-2 text-xs"
          role="status"
        >
          Based on an older commit:{" "}
          <span class="font-mono">{stale.slice(0, 7)}</span>; pushing may
          conflict.
        </p>
      )}
      <div class="min-h-0 flex-1 overflow-auto">
        {files.length === 0 ? (
          <p class="m-0 px-3 py-3 text-sm opacity-70">
            No changes. Edits to files on{" "}
            <span class="font-mono">{defaultBranch}</span> show up here.
          </p>
        ) : (
          <div class="flex flex-col">
            <div class="border-base-300 flex items-center gap-2 border-b px-3 py-2">
              <span class="flex-1 text-xs opacity-70">
                {files.length} changed {files.length === 1 ? "file" : "files"}
              </span>
              <button
                type="button"
                class="btn btn-xs btn-neutral"
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
              {files.map((file) => (
                <ChangeRow
                  key={file.path}
                  file={file}
                  onDiscard={askDiscard}
                  restore={restore}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
      <CommitForm
        appId={appId}
        commit={commit}
        defaultBranch={defaultBranch}
        protectedMain={protectedMain}
        state={state}
      />
    </div>
  );
};
