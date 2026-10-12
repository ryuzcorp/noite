import { BranchPicker } from "$lib/forge/branches";
import { CODE_PANELS, PanelToggles, toCodePanel } from "$lib/forge/code-bar";
import type { CodePanel } from "$lib/forge/code-bar";
import { forgeRefs } from "$lib/forge/data";
import { HistoryView } from "$lib/forge/history";
import { PREVIEW_MIXED_CONTENT_MESSAGE } from "$lib/preview-host";
import { appDetail } from "$lib/resources";
import type { AppRole } from "$lib/roles";
import type { BranchRules, GitRefs } from "$lib/runner";
import { searchParam } from "$lib/search-param";
import type { SearchParam } from "$lib/search-param";
import { sourcePreviewOrigin } from "$lib/server/preview.server";
import { branchRules } from "$lib/source/branch-rules";
import { SourceBrowser } from "$lib/source/browser";
import type { BrowserBase, SourceBrowserProps } from "$lib/source/browser";
import { ChangesPanel } from "$lib/source/changes";
import type { ChangesPanelProps } from "$lib/source/changes";
import type { DraftActions, SourceBrowserState } from "$lib/source/drafts";
import { PreviewInfo, PreviewPanel } from "$lib/source/preview-panel";
import { createPreviewSession } from "$lib/source/preview-session";
import type { PreviewSession } from "$lib/source/preview-session";
import { TerminalPanel } from "$lib/source/terminal-panel";
import { createTerminalSession } from "$lib/source/terminal-session";
import { SidePanel } from "$lib/ui/side-panel";
import { head, useRoute } from "@ilha/router";
import { atom, structuralEqual } from "ilha";
import type { AtomHandle, View } from "ilha";

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

/** The mounted browser's draft actions, once it has handed them over. */
interface Committer {
  actions: DraftActions | null;
}

const newCommitter = (): Committer => ({ actions: null });

const PANEL_TITLE = {
  changes: "Changes",
  history: "History",
  preview: "Preview",
} as const;

/** The panel's tabs, in the bar's own order. The bodies are drawn in it
 * whatever order they were visited in, so a tab opened later never lands
 * before one already there. */
const TAB_ORDER = CODE_PANELS.map((entry) => entry.id);

/** What each tab's body is laid out with, off the aside. `contents` hands the
 * body's own frame the aside's flex column; History keeps its padding and
 * scrolling instead. Every other tab's body is `hidden`: kept in the tree,
 * out of the layout. */
const TAB_CLASS: Record<Exclude<CodePanel, "">, string> = {
  changes: "contents",
  history: "min-h-0 flex-1 overflow-auto px-3 py-3",
  preview: "contents",
};

/** The right panel: History (optionally only the open file), the unpushed
 * Changes or the running Preview. Its own component so `?file=` changes and
 * draft reports re-render it, never SourceBody.
 *
 * Every tab it has shown stays mounted — hidden, never closed — so switching
 * tabs keeps what each one holds: the preview's server and frame (an iframe
 * that is not loaded again), the commit form's draft, History's page and its
 * scroll. ilha closes a keyed child its parent's paint does not reach and
 * reuses an unkeyed one by position, so both the wrapper and the body carry
 * the tab's key: the keyed wrapper keeps a tab opened later from shifting the
 * body drawn where it goes, and the keyed body keeps its own fiber, which a
 * body added ahead of it would otherwise take over. Closing the panel still
 * mounts none of it (see PREVIEW_ABOUT). */
const CodeSidePanel = ({
  appId,
  changes,
  file,
  gitRef,
  onClose,
  panel,
  preview,
  skip,
}: {
  appId: string;
  changes: ChangesPanelProps;
  file: SearchParam<string>;
  gitRef: string;
  onClose: () => void;
  panel: Exclude<CodePanel, "">;
  preview: PreviewSession;
  skip: SearchParam<number>;
}) => {
  const fileOnly = atom(false);
  // The tabs this panel has opened, one set per panel mount: a tab is drawn
  // from its first visit on, so a deep link (`?panel=preview`) mounts only the
  // tab it names, and no tab starts a preview or a fetch before it is opened.
  const opened = atom.lazy(() => new Set<Exclude<CodePanel, "">>())();
  opened.add(panel);
  // `?file=` scopes History to the open file. The scope is read off the open
  // file alone, never off the tab that is showing, so `?file=` writes while
  // another tab holds the panel leave History's body key alone instead of
  // refetching the page it has loaded.
  const scoped = fileOnly() && file() !== "";
  const path = scoped ? file() : "";
  let extras: View | null = null;
  if (panel === "preview") {
    extras = <PreviewInfo session={preview} />;
  } else if (panel === "history" && file() !== "") {
    extras = (
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
    );
  }
  /** One tab's body, keyed by the tab (see above). History is keyed by what it
   * reads — the ref, the scope and the cursor — so a change there remounts it
   * and fetches that page: its `forgeLog` resource stays bound to the key it
   * was first rendered with. */
  const tabBody = (tab: Exclude<CodePanel, "">): View => {
    if (tab === "preview") {
      return <PreviewPanel key={tab} session={preview} />;
    }
    if (tab === "changes") {
      return <ChangesPanel key={tab} {...changes} />;
    }
    return (
      <HistoryView
        key={`${gitRef}:${path}:${skip()}`}
        appId={appId}
        gitRef={gitRef}
        path={path}
        skip={skip}
      />
    );
  };
  const bodies: View[] = [];
  for (const tab of TAB_ORDER) {
    if (!opened.has(tab)) {
      continue;
    }
    bodies.push(
      <div key={tab} class={tab === panel ? TAB_CLASS[tab] : "hidden"}>
        {tabBody(tab)}
      </div>
    );
  }
  return (
    <SidePanel
      title={PANEL_TITLE[panel]}
      onClose={onClose}
      extras={extras}
      classes="col-start-2 row-start-1 lg:col-start-3"
    >
      {bodies}
    </SidePanel>
  );
};

const SourceBody = ({ appId }: { appId: string }) => {
  // The right panel (History, Changes or Preview; "" = closed).
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
  // The terminal panel (`?terminal=1` keeps refresh and deep links working,
  // like `?panel=`).
  const terminalParam = searchParam("terminal", {
    default: "",
    parse: (raw: string): string => (raw === "1" ? "1" : ""),
  });
  // The browser hands its commit function over on mount; the Changes panel
  // calls it.
  const committer = atom.lazy(newCommitter)();
  // The Preview panel's session, one per app: every ref the user browses
  // attaches to this app's own preview host, and a panel left open keeps its
  // frame across a ref change. The origin is the control's answer for this
  // app (the edge serves the pod's four assets there), so guest code never
  // runs on this origin.
  const preview = atom.lazy(() =>
    createPreviewSession({
      origin: async () => {
        const { previewOrigin } = await sourcePreviewOrigin({ appId });
        // The action cannot see the page's scheme through a TLS-terminating
        // proxy: repeat its mixed-content refusal here with the real one, so
        // the panel fails closed instead of mounting an origin that cannot
        // connect. The session shows a thrown message verbatim.
        if (
          previewOrigin.startsWith("http://") &&
          window.location.protocol === "https:"
        ) {
          throw new Error(PREVIEW_MIXED_CONTENT_MESSAGE);
        }
        return previewOrigin;
      },
    })
  )();
  // The terminal panel's session, one per app like the preview: the canvas
  // shows the shell the pod frame runs, and a panel left open keeps it across
  // a ref change (the new browser attaches on mount).
  const terminalSession = atom.lazy(() => createTerminalSession())();
  const browser = atom<SourceBrowserState>({
    files: [],
    pushError: "",
    pushed: null,
    pushing: false,
    revision: 0,
    stale: null,
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
  const terminalOpen = terminalParam() === "1";
  const togglePanel = (next: CodePanel) => {
    // A panel that opens or closes starts History on its first page; switching
    // between open tabs keeps `?skip=`, and with it the page History has
    // loaded, since the tab it pages stays mounted either way.
    if (next === "" || openPanel === "") {
      skip.set(0);
    }
    panel.set(next);
  };
  // One grid holds the tree column, the editor column, the side panel and the
  // terminal panel: the tree spans every row on the left, the editor (and the
  // side panel beside it, 2:1) sits on top, and the terminal spans
  // editor+panel below. The browser's own columns are direct grid items (its
  // wrapper dissolves), while the side panel and the terminal stay siblings
  // here, so a ref change remounts the browser without touching them.
  const pageColumns =
    openPanel === ""
      ? "grid-cols-[18rem_minmax(0,1fr)]"
      : "grid-cols-[18rem_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,2fr)_minmax(0,1fr)]";
  const pageRows = terminalOpen
    ? "grid-rows-[minmax(0,2fr)_minmax(0,1fr)]"
    : "grid-rows-[minmax(0,1fr)]";

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
        class={`relative grid min-h-0 flex-1 overflow-hidden ${pageColumns} ${pageRows}`}
      >
        <BrowserSlot
          appId={appId}
          base={base}
          file={file}
          gitRef={browsing}
          onDraftsReady={(actions) => {
            committer.actions = actions;
          }}
          onState={(state) => {
            browser.set(state);
          }}
          preview={preview}
          terminal={terminalSession}
          terminalParam={terminalParam}
        />
        {openPanel === "" ? null : (
          <CodeSidePanel
            appId={appId}
            changes={{
              appId,
              commit: async (request) =>
                (await committer.actions?.commit(request)) ?? false,
              defaultBranch,
              discard: (path) => {
                committer.actions?.discard(path);
              },
              discardAll: () => {
                committer.actions?.discardAll();
              },
              protectedMain,
              restore: (path) => {
                committer.actions?.restore(path);
              },
              state: browser,
            }}
            file={file}
            gitRef={browsing}
            panel={openPanel}
            preview={preview}
            skip={skip}
            onClose={() => {
              togglePanel("");
            }}
          />
        )}
        {terminalOpen ? (
          <TerminalPanel
            terminal={terminalSession}
            onClose={() => {
              terminalParam.set("");
            }}
          />
        ) : null}
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
  head({ title: "Code · Noite" });
  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }
  return [<SourceBody key={appId} appId={appId} />];
}
