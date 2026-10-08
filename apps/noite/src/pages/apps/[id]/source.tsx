import { BranchPicker } from "$lib/forge/branches";
import { PanelToggles, toCodePanel } from "$lib/forge/code-bar";
import type { CodePanel } from "$lib/forge/code-bar";
import { forgeRefs } from "$lib/forge/data";
import { HistoryView } from "$lib/forge/history";
import { appDetail } from "$lib/resources";
import type { AppRole } from "$lib/roles";
import type { BranchRules, GitRefs } from "$lib/runner";
import { searchParam } from "$lib/search-param";
import type { SearchParam } from "$lib/search-param";
import { branchRules } from "$lib/source/branch-rules";
import { SourceBrowser } from "$lib/source/browser";
import type {
  BrowserBase,
  CommitDrafts,
  SourceBrowserProps,
  SourceBrowserState,
} from "$lib/source/browser";
import { ChangesPanel } from "$lib/source/changes";
import type { ChangesPanelProps } from "$lib/source/changes";
import { SidePanel, splitColumns } from "$lib/ui/side-panel";
import { head, useRoute } from "@ilha/router";
import { atom, structuralEqual } from "ilha";
import type { AtomHandle } from "ilha";

/** Parse `?skip=`: the history cursor (a non-negative integer). */
const toSkip = (raw: string): number => {
  const value = Math.trunc(Number(raw));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

/** The push gate: `require_pr` on and the caller below admin. */
const isProtectedMain = (
  rules: BranchRules | undefined,
  myRole: AppRole | undefined
): boolean => rules?.requirePr === true && myRole !== "admin";

/** The current tip of `name`, or null before the refs load. */
const branchTip = (refs: GitRefs | undefined, name: string): string | null =>
  refs?.branches.find((branch) => branch.name === name)?.sha ?? null;

/** Keep a component atom in step with a value derived from props/resources
 * (an `atom(init)` only seeds on the first render). */
const syncAtom = <T,>(handle: AtomHandle<T>, value: T): void => {
  if (!structuralEqual(handle(), value)) {
    handle.set(value);
  }
};

/** Mounts the browser once per ref. ilha closes a keyed child whenever its
 * parent repaints, unless the parent's whole view is a keyed list. SourceBody
 * repaints on every `?file=`/`?skip=` write, and a remount there throws away
 * the drafts of every other file. So this slot's view is that list. Props
 * other than the key are only read at mount; the ones that change are atoms. */
const BrowserSlot = (props: SourceBrowserProps) => [
  <SourceBrowser key={`${props.appId}:${props.gitRef}`} {...props} />,
];

/** The mounted browser's commit function, once it has handed it over. */
interface Committer {
  commit: CommitDrafts | null;
}

const newCommitter = (): Committer => ({ commit: null });

const PANEL_TITLE = {
  changes: "Changes",
  history: "History",
} as const;

/** The right panel: History (optionally only the open file) or the
 * unpushed Changes. Its own component so `?file=` changes and draft reports
 * re-render it, never SourceBody. */
const CodeSidePanel = ({
  appId,
  changes,
  file,
  gitRef,
  onClose,
  panel,
  skip,
}: {
  appId: string;
  changes: ChangesPanelProps;
  file: SearchParam<string>;
  gitRef: string;
  onClose: () => void;
  panel: Exclude<CodePanel, "">;
  skip: SearchParam<number>;
}) => {
  const fileOnly = atom(false);
  const scoped = panel === "history" && fileOnly() && file() !== "";
  const path = scoped ? file() : "";
  return (
    <SidePanel
      title={PANEL_TITLE[panel]}
      onClose={onClose}
      extras={
        panel === "history" && file() !== "" ? (
          <label class="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              class="checkbox checkbox-xs"
              checked={fileOnly()}
              onchange={(event) => {
                fileOnly.set(event.currentTarget.checked);
                skip.set(0);
              }}
            />
            <span class="truncate">
              Only <span class="font-mono">{file()}</span>
            </span>
          </label>
        ) : null
      }
    >
      {panel === "changes" ? (
        <ChangesPanel {...changes} />
      ) : (
        <div class="min-h-0 flex-1 overflow-auto px-3 py-3">
          <HistoryView
            key={`${gitRef}:${path}:${skip()}`}
            appId={appId}
            gitRef={gitRef}
            path={path}
            skip={skip}
          />
        </div>
      )}
    </SidePanel>
  );
};

const SourceBody = ({ appId }: { appId: string }) => {
  // The right panel (History, Pull requests or Changes; "" = closed).
  // `?panel=` keeps refresh and deep links working.
  const panel = searchParam<CodePanel>("panel", {
    default: "",
    parse: toCodePanel,
  });
  const refs = forgeRefs(appId).data();
  const defaultBranch = refs?.defaultBranch ?? "main";
  // The ref every read is keyed by; no `?ref=` browses the default branch,
  // where edits are committed. The browser subtree is keyed by it so a ref
  // change remounts and refetches.
  const gitRef = searchParam("ref", { default: defaultBranch });
  // Open file lives in ?file= (deep-linkable); the browser reads + writes it.
  const file = searchParam("file", { default: "" });
  // Paging cursor of whichever panel is open.
  const skip = searchParam<number>("skip", { default: 0, parse: toSkip });
  // The browser hands its commit function over on mount; the Changes panel
  // calls it.
  const committer = atom.lazy(newCommitter)();
  const browser = atom<SourceBrowserState>({
    files: [],
    pushError: "",
    pushed: null,
    pushing: false,
    revision: 0,
  });

  // main is protected when `require_pr` is on and the caller is below admin;
  // the Changes panel then only commits to a new branch.
  const rules = branchRules(appId).data();
  const myRole = appDetail(appId).data()?.myRole;
  const protectedMain = isProtectedMain(rules, myRole);
  const base = atom<BrowserBase>({ defaultBranch, mainSha: null });
  syncAtom(base, {
    defaultBranch,
    mainSha: branchTip(refs, defaultBranch),
  });
  const browsing = gitRef();
  const openPanel = panel();
  const togglePanel = (next: CodePanel) => {
    // `?skip=` pages History; a new panel starts on its first page.
    skip.set(0);
    panel.set(next);
  };

  return (
    <div class="flex h-screen w-full flex-col overflow-hidden">
      <div class="border-base-300 flex items-center gap-2 border-b px-4 py-2">
        <BranchPicker
          appId={appId}
          value={browsing}
          onChange={(next) => {
            gitRef.set(next);
          }}
        />
        <div class="ml-auto flex items-center gap-2">
          <PanelToggles
            active={openPanel}
            appId={appId}
            changeCount={() => browser().files.length}
            onToggle={togglePanel}
          />
        </div>
      </div>
      <div
        class={`relative grid min-h-0 flex-1 overflow-hidden ${splitColumns(openPanel !== "")}`}
      >
        <div class="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <BrowserSlot
            appId={appId}
            base={base}
            file={file}
            gitRef={browsing}
            onCommitReady={(commit) => {
              committer.commit = commit;
            }}
            onState={(state) => {
              browser.set(state);
            }}
          />
        </div>
        {openPanel === "" ? null : (
          <CodeSidePanel
            appId={appId}
            changes={{
              appId,
              commit: async (request) =>
                (await committer.commit?.(request)) ?? false,
              defaultBranch,
              protectedMain,
              state: browser,
            }}
            file={file}
            gitRef={browsing}
            panel={openPanel}
            skip={skip}
            onClose={() => {
              togglePanel("");
            }}
          />
        )}
      </div>
    </div>
  );
};

/** Source preview for one app — files of the latest pushed commit. The
 * body is keyed by app id so an id change remounts it (see the app page:
 * reused fibers keep resource()/feed slots bound to their first key), and
 * handed over as a one-item keyed list so a `?file=` write does not remount
 * it and drop its drafts: with the id as the only prop ilha reuses the row,
 * and the body repaints through its own param reads. */
export default function Source() {
  const appId = useRoute().params().id;
  head({ title: "Source · Noite" });
  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }
  return [<SourceBody key={appId} appId={appId} />];
}
