/** The source page's Changes panel: every unpushed edit as a diff, and the
 * commit form under it (message, target branch, Push). The drafts live in
 * the browser; this reads the state it reports and asks it to commit. */
import { atom } from "ilha";
import type { AtomHandle } from "ilha";

import { DraftDiffView } from "../forge/diff";
import type { CommitDrafts, PushRequest, SourceBrowserState } from "./browser";

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
  /** `require_pr` on and the caller below admin: new branches only. */
  protectedMain: boolean;
  state: AtomHandle<SourceBrowserState>;
}

/** The diff of every draft (rebuilt per revision), then the commit form. */
export const ChangesPanel = ({
  appId,
  commit,
  defaultBranch,
  protectedMain,
  state,
}: ChangesPanelProps) => {
  const { files, revision } = state();
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-auto">
        {files.length === 0 ? (
          <p class="m-0 px-3 py-3 text-sm opacity-70">
            No changes. Edits to files on{" "}
            <span class="font-mono">{defaultBranch}</span> show up here.
          </p>
        ) : (
          <DraftDiffView
            key={`drafts:${revision}`}
            emptyLabel="No changes."
            files={files}
          />
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
