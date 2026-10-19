import { api } from "$lib/api";
import { BranchPicker } from "$lib/forge/branches";
import { CODE_PANELS, PanelToggles, toCodePanel } from "$lib/forge/code-bar";
import type { CodePanel } from "$lib/forge/code-bar";
import { forgeRefs } from "$lib/forge/data";
import { HistoryView } from "$lib/forge/history";
import { collectRef, newLiveRef } from "$lib/live-ref";
import { PREVIEW_MIXED_CONTENT_MESSAGE } from "$lib/preview-host";
import { appDetail } from "$lib/resources";
import type { AppRole } from "$lib/roles";
import type { GitRefs, RunnerEnvironment } from "$lib/runner";
import { parseSkip, searchParam } from "$lib/search-param";
import type { SearchParam } from "$lib/search-param";
import { branchRules } from "$lib/source/branch-rules";
import { SourceBrowser } from "$lib/source/browser";
import type { SourceBrowserProps } from "$lib/source/browser";
import { ChangesPanel } from "$lib/source/changes";
import type { ChangesPanelProps } from "$lib/source/changes";
import type {
  DraftActions,
  ReadOnlyRef,
  SourceBrowserState,
} from "$lib/source/drafts";
import { PreviewPanel } from "$lib/source/preview-panel";
import { editableRef, protectedRef } from "$lib/source/push-target";
import { TerminalPanel } from "$lib/source/terminal-panel";
import { createTerminalSession } from "$lib/source/terminal-session";
import { SquareTerminal } from "$lib/ui/icons";
import { createPaneGroup, MORPH_PRESERVE } from "$lib/ui/resizable";
import { ResizeHandle } from "$lib/ui/resize-handle";
import { SidePanel } from "$lib/ui/side-panel";
import { useParams } from "@ilha/void";
import * as Equal from "effect/Equal";
import { atom, watch } from "ilha";
import type { AtomHandle, View } from "ilha";

/** Keep a component atom in step with a value derived from props/resources
 * (an `atom(init)` only seeds on the first render). */
const syncAtom = <T,>(handle: AtomHandle<T>, value: T): void => {
  if (!Equal.equals(handle(), value)) {
    handle.set(value);
  }
};

/** Mounts the browser once per app. ilha closes a keyed child whenever its
 * parent repaints, unless the parent's whole view is a keyed list. SourceBody
 * repaints on every `?file=`/`?skip=` write, and a remount there throws away
 * the drafts of every other file. So this slot's view is that list. Props
 * other than the key are only read at mount; the ones that change are atoms —
 * `?ref=` among them: a branch switch is the browser's own (it installs the
 * new ref's checkout under the panes it already has, see `./source/browser`),
 * so the key must not name the ref. */
const BrowserSlot = (props: SourceBrowserProps) => [
  <SourceBrowser key={props.appId} {...props} />,
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

/** The refs a sha (`?ref=` mid-commit, a commit link) looks like: the
 * runner's own `is_hex_sha` (7..=40 hex digits). */
const SHA_REF = /^[0-9a-f]{7,40}$/iu;

/** Why the browsed ref opens read-only. A branch the viewer may push to is
 * editable (`editableRef`); a branch they may not is a role, and anything
 * that is not a branch at all is a commit when it looks like a sha and a tag
 * otherwise (the refs list is the only place the UI learns a name is a
 * branch). */
const readOnlyReason = (
  refs: GitRefs | undefined,
  role: AppRole | undefined,
  ref: string
): ReadOnlyRef => {
  if (editableRef(refs, role, ref)) {
    return "";
  }

  if (refs?.branches.some((branch) => branch.name === ref) === true) {
    return "role";
  }

  return SHA_REF.test(ref) ? "commit" : "tag";
};

/** Code mode's pane groups (`$lib/ui/resizable`): the file tree against
 * everything else, that column in two (the editor beside the side panel, the
 * terminal under them both). They exist at `lg` and up, and each keeps its own
 * split in localStorage; below `lg` nothing is bound and the classes on the
 * same elements lay the page out exactly as before — the tree column at its
 * own width, the editor beside it, the terminal under them and the panel over
 * the lot. */
const TREE_PANES = {
  direction: "horizontal",
  key: "code-tree",
  minPx: [180, 320],
} as const;

const PANEL_PANES = {
  collapsible: [1],
  direction: "horizontal",
  key: "code-panel",
  minPx: [320, 280],
} as const;

const TERMINAL_PANES = {
  direction: "vertical",
  key: "code-terminal",
  minPx: [200, 120],
} as const;

/** The tree column's footer: toggles `?terminal=1`, styled like the Code mode
 * bar's panel toggles. */
const TerminalToggle = ({ param }: { param: SearchParam<string> }) => {
  const open = param() === "1";

  return (
    <button
      type="button"
      class={`btn btn-sm w-full justify-start ${open ? "btn-neutral" : "btn-ghost"}`}
      aria-pressed={open ? "true" : "false"}
      onclick={() => {
        param.set(open ? "" : "1");
      }}
    >
      <SquareTerminal />
      Terminal
    </button>
  );
};

/** The right panel: History (optionally only the open file) or the unpushed
 * Changes. Its own component so `?file=` changes and
 * draft reports re-render it, never SourceBody.
 *
 * Every tab it has shown stays mounted — hidden, never closed — so switching
 * tabs keeps what each one holds: the commit form's draft, History's page and
 * its scroll. ilha closes a keyed child its parent's paint does not reach and
 * reuses an unkeyed one by position, so both the wrapper and the body carry
 * the tab's key: the keyed wrapper keeps a tab opened later from shifting the
 * body drawn where it goes, and the keyed body keeps its own fiber, which a
 * body added ahead of it would otherwise take over. The component itself
 * outlives the panel being closed (the pane it fills has to stay for the slide
 * that closes it), so `open` is what mounts the tabs at all: closed, every tab
 * in it is let go. */
const CodeSidePanel = ({
  appId,
  changes,
  defaultSize,
  file,
  gitRef,
  onClose,
  onDeployPreview,
  open,
  panel,
  skip,
  state,
}: {
  appId: string;
  changes: ChangesPanelProps;
  /** The share of the editor's group the pane opens at, in percent (`null`
   * when nothing has been dragged: the page's own even split). */
  defaultSize: number | null;
  file: SearchParam<string>;
  gitRef: string;
  onClose: () => void;
  /** Snapshot the workspace's changes and deploy their environment (the
   * Preview panel's Deploy preview; null when there is nothing to deploy). */
  onDeployPreview: () => Promise<RunnerEnvironment | null>;
  /** Whether `?panel=` names a tab: closed, the tabs are unmounted and the
   * pane is inert. */
  open: boolean;
  /** `?panel=`: the tab that is showing, "" when the panel is closed. */
  panel: CodePanel;
  skip: SearchParam<number>;
  state: AtomHandle<SourceBrowserState>;
}) => {
  const fileOnly = atom(false);
  // The tab whose pane this is: closed, the header still has to name something
  // (`?panel=` says nothing) — and it never shows, because a closed pane is
  // clipped to nothing and inert.
  const tab = panel === "" ? "history" : panel;

  // The tabs this panel has opened, one set per panel mount: a tab is drawn
  // from its first visit on, so a deep link (`?panel=history`) mounts only the
  // tab it names, and no tab fetches before it is opened.
  // A Set does not survive the SSR snapshot (serializes as `{}`), so it
  // stays out of it; the client builds its own on hydration.
  const opened = atom.lazy(() => new Set<Exclude<CodePanel, "">>(), {
    snapshot: false,
  })();

  if (open) {
    opened.add(tab);
  }

  // `?file=` scopes History to the open file. The scope is read off the open
  // file alone, never off the tab that is showing, so `?file=` writes while
  // another tab holds the panel leave History's body key alone instead of
  // refetching the page it has loaded.
  const scoped = fileOnly() && file() !== "";
  const path = scoped ? file() : "";
  let extras: View | null = null;

  if (tab === "history" && file() !== "") {
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
  const tabBody = (body: Exclude<CodePanel, "">): View => {
    if (body === "changes") {
      return <ChangesPanel key={body} {...changes} />;
    }

    if (body === "preview") {
      return (
        <PreviewPanel
          key={body}
          appId={appId}
          branch={gitRef}
          onClose={onClose}
          onDeployPreview={onDeployPreview}
          state={state}
        />
      );
    }

    return (
      <HistoryView
        key={`${gitRef}:${path}:${skip()}`}
        appId={appId}
        file={file()}
        gitRef={gitRef}
        path={path}
        skip={skip}
      />
    );
  };

  const bodies: View[] = [];

  for (const drawn of TAB_ORDER) {
    if (!opened.has(drawn)) {
      continue;
    }

    bodies.push(
      <div key={drawn} class={drawn === tab ? TAB_CLASS[drawn] : "hidden"}>
        {tabBody(drawn)}
      </div>
    );
  }

  return (
    // The panel is a pane of the page's own group: it closes to nothing (the
    // divider between the editor and it is the page's), and while it is closed
    // no tab of it is mounted — every tab is let go. The rest of the panel (its
    // bar) stays, because the pane it fills has to be there for the slide that
    // closes it. Below `lg` the page's group is unbound: the pane is hidden
    // when closed, and when it is open the panel covers the page, as before.
    <div
      data-slot="resizable-panel"
      data-collapsible=""
      data-collapsed-size="0"
      data-default-size={defaultSize}
      data-morph-preserve={MORPH_PRESERVE}
      inert={open ? undefined : true}
      class={`min-h-0 min-w-0 lg:flex lg:shrink-0 lg:grow-0 lg:basis-1/2 ${open ? "" : "max-lg:hidden"}`}
    >
      <SidePanel
        title={PANEL_TITLE[tab]}
        bare={tab === "preview"}
        onClose={onClose}
        extras={extras}
        slide
        classes="lg:flex-1"
      >
        {open ? bodies : null}
      </SidePanel>
    </div>
  );
};

const SourceBody = ({ appId }: { appId: string }) => {
  // The right panel (History or Changes; "" = closed).
  // `?panel=` keeps refresh and deep links working.
  const panel = searchParam<CodePanel>("panel", {
    default: "",
    parse: toCodePanel,
  });

  const refsRes = forgeRefs(appId);
  const refs = refsRes.data();
  const defaultBranch = refs?.defaultBranch ?? "main";
  // The ref every read is keyed by; no `?ref=` browses the default branch. The
  // handle goes to the browser, which switches its checkout in place on every
  // change (the panels below read the value, so they follow it too).
  const gitRef = searchParam("ref", { default: defaultBranch });
  // Open file lives in ?file= (deep-linkable); the browser reads + writes it.
  const file = searchParam("file", { default: "" });
  // Paging cursor of whichever panel is open.
  const skip = searchParam<number>("skip", { default: 0, parse: parseSkip });

  // The terminal panel (`?terminal=1` keeps refresh and deep links working,
  // like `?panel=`).
  const terminalParam = searchParam("terminal", {
    default: "",
    parse: (raw: string): string => (raw === "1" ? "1" : ""),
  });

  // The browser hands its commit function over on mount; the Changes panel
  // calls it.
  const committer = atom.lazy(newCommitter)();

  // The pod host origin, resolved when a checkout opens: every ref the user
  // browses frames the pod host there. The action answers with the control's
  // origin for this app (the edge serves the pod's four assets there), so guest
  // code never runs on this page's origin.
  const podHostOrigin = async (): Promise<string> => {
    const { previewOrigin } = await api<{ previewOrigin: string }>(
      "/api/preview/sourcePreviewOrigin",
      { appId }
    );

    // The action cannot see the page's scheme through a TLS-terminating
    // proxy: repeat its mixed-content refusal here with the real one, so the
    // browser fails closed instead of framing an origin that cannot connect.
    if (
      previewOrigin.startsWith("http://") &&
      window.location.protocol === "https:"
    ) {
      throw new Error(PREVIEW_MIXED_CONTENT_MESSAGE);
    }

    return previewOrigin;
  };

  // The terminal panel's session: the canvas shows the shell the pod frame
  // runs, and a panel left open keeps it across a ref change (the new browser
  // attaches on mount).
  // The session is closures over the shell (functions do not serialize), so
  // it stays out of the SSR snapshot; the client builds its own on hydration.
  const terminalSession = atom.lazy(() => createTerminalSession(), {
    snapshot: false,
  })();

  // The state every group below is seeded with: which tab `?panel=` names
  // ("" = closed) and whether the terminal is open.
  const openPanel = panel();
  const terminalOpen = terminalParam() === "1";

  /** Close the side panel: the URL is the panel's state, so the pane, the
   * toggle and the tabs all follow it from there. A drag that takes the pane
   * past its minimum goes through here too (see `onCollapsed`). */
  const closePanel = (): void => {
    skip.set(0);
    panel.set("");
  };

  // The page's pane groups. Each keeps its own split in localStorage and binds
  // to the elements below at `lg` and up; the side panel's own state follows
  // `?panel=` (see `setOpen` in the render).
  // Pane groups hold functions and DOM state (see layout.tsx): out of the
  // snapshot, rebuilt by the client on hydration.
  const treePanes = atom.lazy(() => createPaneGroup(TREE_PANES), {
    snapshot: false,
  })();

  const panelPanes = atom.lazy(
    () =>
      createPaneGroup({
        ...PANEL_PANES,
        closed: openPanel === "" ? [...PANEL_PANES.collapsible] : [],
        onCollapsed: () => {
          closePanel();
        },
      }),
    { snapshot: false }
  )();

  const terminalPanes = atom.lazy(() => createPaneGroup(TERMINAL_PANES), {
    snapshot: false,
  })();

  // The tree column's shadow-pane host: the column is a pane of this page's
  // own group, so the page renders it and hands the browser the mount point
  // (see `./source/browser`).
  const treeHost = atom.lazy(() => newLiveRef<HTMLElement>())();

  const browser = atom<SourceBrowserState>({
    conflicts: [],
    files: [],
    previewed: null,
    pushError: "",
    pushed: null,
    pushing: false,
    readOnly: "",
    revision: 0,
    stale: null,
  });

  // main is protected when `require_pr` is on and the caller is below admin;
  // the Changes panel then only commits to a new branch.
  const rules = branchRules(appId).data();
  const detailRes = appDetail(appId);
  const myRole = detailRes.data()?.myRole;
  const browsing = gitRef();

  /** Why the browsed ref opens read-only ("" = editable — see
   * `readOnlyReason`). Asked when the browser opens the checkout rather than
   * handed over, because both answers arrive after the browser mounts — and
   * answered off the current state, never the render's. A list that does not
   * hold the ref is read again either way: the picker creates a branch and
   * switches to it in the same breath, and a *loaded* list without that branch
   * is the one answer that is certainly stale (a tag or a raw commit is simply
   * absent again, and stays read-only). */
  const canEditRef = async (ref: string): Promise<ReadOnlyRef> => {
    const loaded = refsRes.data();

    const stale =
      loaded === undefined ||
      !loaded.branches.some((branch) => branch.name === ref);

    const known = stale || refsRes.loading() ? await refsRes.refetch() : loaded;
    let role = myRole;

    if (role === undefined) {
      const detail = await detailRes.refetch();
      role = detail?.myRole;
    }

    return readOnlyReason(known, role, ref);
  };

  // The ref the browser browses, kept in step with `?ref=` here: the browser
  // watches it and installs that ref's checkout under the panes it already has
  // (see `./source/browser`), so `?ref=` no longer remounts it — the keyed
  // list below hands it the app alone. An atom rather than the param handle:
  // the browser's request has to be started from a watch, not a render.
  const ref = atom(gitRef());
  syncAtom(ref, gitRef());
  // The side panel opens and closes through the library, not through the
  // render: `?panel=` is the state, and the pane slides to it (the split either
  // side of it and the divider between them are the group's). Applied here,
  // ahead of the paint that mounts or lets go of the tabs, so the slide and the
  // content stay in step — and idempotent, so a repaint never re-opens a pane
  // the user dragged shut.
  panelPanes.setOpen(1, openPanel !== "");

  const togglePanel = (next: CodePanel) => {
    // A panel that opens or closes starts History on its first page; switching
    // between open tabs keeps `?skip=`, and with it the page History has
    // loaded, since the tab it pages stays mounted either way.
    if (next === "") {
      closePanel();

      return;
    }

    if (openPanel === "") {
      skip.set(0);
    }

    panel.set(next);
  };

  // Everything the page holds is let go with it.
  watch.once(({ onCleanup }) => {
    onCleanup(() => {
      treePanes.destroy();
      panelPanes.destroy();
      terminalPanes.destroy();
    });
  });
  // The splits the panes open at: what the user last dragged them to, or
  // nothing (the page's own classes, which are the layout below `lg` anyway).
  const treeSplit = treePanes.stored(2);
  const panelSplit = panelPanes.stored(2);
  const terminalSplit = terminalPanes.stored(terminalOpen ? 2 : 1);

  return (
    // The app shell already sits under a 3rem top bar below `lg`: this page
    // fills what that leaves, exactly as the app detail shell does, so its
    // bottom line is not 3rem past the viewport.
    <div class="flex h-[calc(100dvh-3rem)] w-full flex-col overflow-hidden lg:h-dvh">
      <div class="border-base-300 flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <BranchPicker
          appId={appId}
          value={browsing}
          onChange={(next) => {
            gitRef.set(next);
          }}
        />
        <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
          <PanelToggles
            active={openPanel}
            appId={appId}
            changeCount={() => browser().files.length}
            onToggle={togglePanel}
          />
        </div>
      </div>
      {/* The page's panes, nested: the file tree against everything else, that
          column in three (the editor beside the side panel, the terminal under
          them). The groups bind at `lg` and up (see `$lib/ui/resizable`);
          below `lg` these same classes lay the page out as it always was — the
          tree column, the editor beside it, the terminal under both and the
          side panel over the lot (`relative` is what that overlay and the
          browser's own overlays measure themselves against). */}
      <div
        ref={treePanes.ref}
        data-slot="resizable"
        data-direction="horizontal"
        data-morph-preserve={MORPH_PRESERVE}
        class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {/* The file tree, at the width the page has always given it (`w-72`)
            until the split says otherwise. */}
        <div
          data-slot="resizable-panel"
          data-default-size={treeSplit?.[0]}
          data-morph-preserve={MORPH_PRESERVE}
          class="bg-base-200/50 border-base-300 flex w-72 shrink-0 grow-0 flex-col justify-between border-r"
        >
          <div
            ref={(host) => {
              collectRef(treeHost, host);
            }}
            class="noite-src-tree min-h-0 min-w-0 flex-1 overflow-auto pt-2"
          ></div>
          <div class="border-base-300 border-t p-2">
            <TerminalToggle param={terminalParam} />
          </div>
        </div>
        <ResizeHandle label="Resize file tree" />
        {/* What the tree leaves: the editor and the terminal, split
            vertically. */}
        <div
          data-slot="resizable-panel"
          data-default-size={treeSplit?.[1]}
          data-morph-preserve={MORPH_PRESERVE}
          class="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div
            ref={terminalPanes.ref}
            data-slot="resizable"
            data-direction="vertical"
            data-morph-preserve={MORPH_PRESERVE}
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {/* The editor beside the side panel — below `lg` the panel covers
                the page instead, so this row is the editor alone — and the
                terminal below them. */}
            <div
              data-slot="resizable-panel"
              data-default-size={panelSplit?.[0]}
              data-morph-preserve={MORPH_PRESERVE}
              class={`flex min-h-0 min-w-0 shrink-0 grow-0 ${terminalOpen ? "basis-2/3" : "basis-full"}`}
            >
              <div
                ref={panelPanes.ref}
                data-slot="resizable"
                data-direction="horizontal"
                data-morph-preserve={MORPH_PRESERVE}
                class="flex min-h-0 min-w-0 flex-1 overflow-hidden"
              >
                <BrowserSlot
                  appId={appId}
                  canEditRef={canEditRef}
                  file={file}
                  gitRef={ref}
                  onDraftsReady={(actions) => {
                    committer.actions = actions;
                  }}
                  onState={(state) => {
                    browser.set(state);
                  }}
                  podHostOrigin={podHostOrigin}
                  terminal={terminalSession}
                  treeHost={treeHost}
                />
                <ResizeHandle label="Resize side panel" />
                <CodeSidePanel
                  appId={appId}
                  changes={{
                    appId,
                    branch: browsing,
                    branches: refs?.branches ?? [],
                    commit: async (request) =>
                      (await committer.actions?.commit(request)) ?? false,
                    defaultBranch,
                    discard: (path) => {
                      committer.actions?.discard(path);
                    },
                    discardAll: () => {
                      committer.actions?.discardAll();
                    },
                    dismissConflicts: (path) => {
                      committer.actions?.dismissConflicts(path);
                    },
                    // Branch protection covers the default branch alone (the
                    // only ref the runner refuses a direct commit to): the
                    // commit target select disables it and offers a new branch
                    // instead. Browsing another branch takes its commits
                    // however the app-wide rule is set (see `./push-target`).
                    isProtected: (name) =>
                      protectedRef(rules, myRole, name, defaultBranch),
                    restore: (path) => {
                      committer.actions?.restore(path);
                    },
                    state: browser,
                  }}
                  defaultSize={panelSplit?.[1] ?? null}
                  file={file}
                  gitRef={browsing}
                  onClose={() => {
                    togglePanel("");
                  }}
                  onDeployPreview={async () => {
                    const previewed = await committer.actions?.preview();

                    return previewed?.environment ?? null;
                  }}
                  open={openPanel !== ""}
                  panel={openPanel}
                  skip={skip}
                  state={browser}
                />
              </div>
            </div>
            {terminalOpen ? (
              <ResizeHandle label="Resize terminal" vertical />
            ) : null}
            {terminalOpen ? (
              <TerminalPanel
                defaultSize={terminalSplit?.[1]}
                terminal={terminalSession}
                onClose={() => {
                  terminalParam.set("");
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Source browser for one app — files of the latest pushed commit. The
 * body is keyed by app id so an id change remounts it (see the app page:
 * reused fibers keep resource()/feed slots bound to their first key), and
 * handed over as a one-item keyed list so a `?file=` write does not remount
 * it and drop its drafts: with the id as the only prop ilha reuses the row,
 * and the body repaints through its own param reads. */
export default function Source() {
  const { id: appId } = useParams();

  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }

  return [<SourceBody key={appId} appId={appId} />];
}
