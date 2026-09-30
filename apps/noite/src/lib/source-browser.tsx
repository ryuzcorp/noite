/**
 * Source browser: file tree (@pierre/trees) + code preview / last-push diff
 * (@pierre/diffs), both mounted imperatively from their vanilla APIs.
 *
 * The three pane hosts use `ref` callbacks; setup runs once in
 * `watch.once(async ({ signal, onCleanup }) => …)` (client-only, once per
 * mount) and aborts via `signal` on unmount. The page drives the view
 * through the `mode` atom (`watch(mode, …)`); draft/push state flows back
 * through `onState`. The pierre `onEditChange` stays imperative — only the
 * derived counts cross into atoms.
 *
 * Data comes from the runner's bare-mirror endpoints via server-side actions
 * (sourceTree / sourceBlob / sourceDiff) — the browser never sees tokens.
 */
import type { SearchParam } from "@ilha/router";
import type { EditorChangeEvent, EditorOptions } from "@pierre/diffs/edit";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import {
  sourceBlob,
  sourceCommit,
  sourceDiff,
  sourceTree,
} from "./apps.server";
import { errorMessage } from "./errors";
import { collectRef, newLiveRef, whenLive } from "./live-ref";
import type { LiveRef } from "./live-ref";
import type { RunnerBlob } from "./runner";
import { readSwr, writeSwr } from "./swr-store";

/** Sort flat file paths so folders come first at every level, then
 * files — alphabetical within each group (segment-wise compare). */
const sortTreePaths = (paths: string[]): string[] =>
  paths.toSorted((a, b) => {
    const as = a.split("/");
    const bs = b.split("/");
    const len = Math.min(as.length, bs.length);
    for (let i = 0; i < len; i += 1) {
      const charA = as[i] ?? "";
      const charB = bs[i] ?? "";
      if (charA !== charB) {
        const aIsDir = i < as.length - 1;
        const bIsDir = i < bs.length - 1;
        if (aIsDir !== bIsDir) {
          return aIsDir ? -1 : 1;
        }
        return charA < charB ? -1 : 1;
      }
    }
    return as.length - bs.length;
  });

const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

/** Curated highlight languages (resource opt T6.1): what tenant Worker repos
 * contain. Resolved shiki ids (note: `sh` resolves to `zsh`). Anything else
 * renders as plain text — no on-demand grammar download, no egress.
 * Preloaded once below so first paint never waits on a grammar chunk. */
const CURATED_LANGS: readonly string[] = [
  "css",
  "html",
  "javascript",
  "json",
  "jsonc",
  "jsx",
  "markdown",
  "sql",
  "text",
  "toml",
  "tsx",
  "typescript",
  "yaml",
  "zsh",
];

/** Map a filename to its highlight language, capped to the curated set. */
const curatedLang = (
  name: string,
  resolve: (filename: string) => string
): string => {
  const lang = resolve(name);
  return CURATED_LANGS.includes(lang) ? lang : "text";
};

/** Minimal shapes — the real types live in @pierre/* once installed. */
interface PreparedTreeInput {
  paths: readonly string[];
  presorted: true;
}

interface TreesModule {
  FileTree: new (opts: {
    preparedInput: PreparedTreeInput;
    search?: boolean;
    initialExpandedPaths?: string[];
    initialSelectedPaths?: readonly string[];
    onSelectionChange?: (selected: readonly string[]) => void;
  }) => {
    render: (opts: { fileTreeContainer: HTMLElement }) => void;
    subscribe: (fn: () => void) => void;
    getSelectedPaths: () => string[];
    cleanUp: () => void;
  };
  preparePresortedFileTreeInput: (paths: string[]) => PreparedTreeInput;
}

/** Minimal pierre File view surface (render target + edit attach). */
interface PierreFileView {
  cleanUp: () => void;
  render: (opts: {
    containerWrapper: HTMLElement | null;
    file: { contents: string; name: string; lang?: string };
  }) => void;
}

/** Minimal pierre editor surface: attach to a File view, read text.
 * The full Editor class carries generics the vanilla side never needs. */
interface PierreEditor {
  cleanUp: () => void;
  edit: (file: PierreFileView) => () => void;
  getText: () => string;
}

interface EditModule {
  Editor: new (
    type: "file",
    options?: EditorOptions<"file", undefined, undefined>,
    editStateKey?: string
  ) => PierreEditor;
}

interface DiffsModule {
  File: new (opts?: {
    theme?: unknown;
    overflow?: string;
    onEditChange?: (
      event: EditorChangeEvent<"file", undefined, undefined>
    ) => void;
  }) => PierreFileView;
  FileDiff: new (opts?: { theme?: unknown; diffStyle?: string }) => {
    render: (opts: {
      fileDiff: unknown;
      containerWrapper: HTMLElement;
    }) => void;
    cleanUp: () => void;
  };
  parsePatchFiles: (patch: string) => { files: unknown[] }[];
  getFiletypeFromFileName: (filename: string) => string;
  preloadHighlighter: (opts: {
    langs: string[];
    themes: string[];
  }) => Promise<void>;
}

/** Imperative handles the page's watchers call into (filled once setup completes). */
interface BrowserApi {
  commit: (() => void) | undefined;
  show: ((mode: SourceMode) => void) | undefined;
}

export type SourceMode = "files" | "diff";

/** The runner's tree listing for the latest pushed commit. */
type TreeData = Awaited<ReturnType<typeof sourceTree>>;

/** Per-instance browser state that must outlive re-renders (see below). */
interface BrowserBox {
  api: BrowserApi;
  /** Pane hosts as live refs: re-renders also hand `ref` detached scratch
   * copies, so the setup resolves the connected host (live-ref.ts). */
  code: LiveRef<HTMLElement>;
  diff: LiveRef<HTMLElement>;
  hostsReady: PromiseWithResolvers<boolean>;
  tree: LiveRef<HTMLElement>;
}

const newBrowserBox = (): BrowserBox => ({
  api: { commit: undefined, show: undefined },
  code: newLiveRef<HTMLElement>(),
  diff: newLiveRef<HTMLElement>(),
  hostsReady: Promise.withResolvers<boolean>(),
  tree: newLiveRef<HTMLElement>(),
});

/** Draft/push state reported to the page (which renders the header). */
export interface SourceBrowserState {
  dirty: number;
  pushing: boolean;
  pushError: boolean;
}

/** Styles inside each pane's shadow root: fill the host, and stretch the
 * content-sized pierre element so short files still fill the code area. */
const PANE_CSS = `
:host { display: block; }
.pane { display: flex; flex-direction: column; min-height: 100%; }
.pane > * { flex: 1; min-height: 100%; }
`;

/** The mount point pierre renders into, inside a shadow root on `host`.
 * ilha re-renders this component often (every onState report, every
 * ?file= write), and its morph makes a host's light-DOM children and
 * attributes match the (empty) JSX — deleting pierre's editor/diff nodes
 * and stripping its host styles. Shadow content is invisible to the morph;
 * theme custom properties set on the host still inherit into it. */
const paneIn = (host: HTMLElement): HTMLElement => {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const existing = root.querySelector<HTMLElement>(".pane");
  if (existing) {
    return existing;
  }
  const style = document.createElement("style");
  style.textContent = PANE_CSS;
  const pane = document.createElement("div");
  pane.className = "pane";
  root.append(style, pane);
  return pane;
};

export const SourceBrowser = ({
  appId,
  file,
  mode,
  onState,
  push,
}: {
  appId: string;
  file: SearchParam<string>;
  mode: AtomHandle<SourceMode>;
  onState: (state: SourceBrowserState) => void;
  push: AtomHandle<number>;
}) => {
  // Per-instance state that must outlive re-renders. The page re-renders
  // on every onState() report, and ilha runs the *latest* render's watch
  // callbacks while `ref` only fires on mount — so plain `let`s here would
  // hand the mode/push watchers an empty api after the first report.
  // atom.lazy returns the same box every render.
  const box = atom.lazy(newBrowserBox)();
  const attach =
    (slot: "code" | "diff" | "tree") => (host: HTMLElement | null) => {
      collectRef(box[slot], host);
      if (
        box.tree.els.length > 0 &&
        box.code.els.length > 0 &&
        box.diff.els.length > 0
      ) {
        box.hostsReady.resolve(true);
      }
    };
  // Mode/push watchers fire once on mount, before setup fills the api —
  // guarded no-ops until then.
  watch(mode, (m) => {
    box.api.show?.(m);
  });
  watch(push, () => {
    // Mount-fire (count 0) lands before setup fills api — a no-op; real
    // pushes increment past it (an early commit would early-return anyway).
    box.api.commit?.();
  });
  watch.once(async ({ onCleanup, signal }) => {
    // watch.once runs during render, before the JSX (and its refs) exist:
    // wait for all three host elements to attach.
    await box.hostsReady.promise;
    // The refs fire before insertion: wait for the hosts that are really in
    // the document, and only then give each its shadow pane (never on a
    // scratch copy the morph is about to discard).
    const [treeHost, codeHost, diffHost] = await Promise.all([
      whenLive(box.tree, signal),
      whenLive(box.code, signal),
      whenLive(box.diff, signal),
    ]);
    if (signal.aborted || !treeHost || !codeHost || !diffHost) {
      return;
    }
    const treeEl = paneIn(treeHost);
    const codeEl = paneIn(codeHost);
    const diffEl = paneIn(diffHost);
    const aborted = (): boolean => signal.aborted;

    let currentMode: SourceMode = mode();
    let modeSeq = 0;
    // Drafts live here (never in atoms): the code pane is always
    // pierre-editable — no edit mode, no toggle.
    let pushing = false;
    let pushError = false;
    let currentPath: string | null = null;
    let currentEditable = false;
    const drafts = new Map<string, string>();
    const originals = new Map<string, string>();
    const syncState = () => {
      onState({ dirty: drafts.size, pushError, pushing });
    };
    // Pane visibility renders from the `mode` prop (see the JSX); this only
    // tracks the mode for the async guards below.
    const setMode = (next: SourceMode) => {
      modeSeq += 1;
      currentMode = next;
    };
    let diffViews: { cleanUp: () => void }[] = [];

    let trees: TreesModule;
    let diffs: DiffsModule;
    let editMod: EditModule;
    try {
      const modulesPromise = Promise.all([
        import("@pierre/trees"),
        import("@pierre/diffs"),
        import("@pierre/diffs/edit"),
      ]);
      // SAFETY: import() resolves the installed @pierre modules which structurally match TreesModule/DiffsModule/EditModule.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- vendor types drift from the minimal local interfaces; unknown bridges them.
      const loaded = (await modulesPromise) as unknown as [
        TreesModule,
        DiffsModule,
        EditModule,
      ];
      const [treesMod, diffsMod, editModLoaded] = loaded;
      trees = treesMod;
      diffs = diffsMod;
      editMod = editModLoaded;
    } catch {
      treeEl.textContent =
        "@pierre/trees + @pierre/diffs not installed — run `bun install` in apps/noite";
      return;
    }
    if (aborted()) {
      return;
    }
    const { FileTree, preparePresortedFileTreeInput } = trees;
    const { File, FileDiff, parsePatchFiles } = diffs;
    // Warm only the curated grammars (T6.1); anything else stays plain
    // text and never triggers a grammar download. Fire-and-forget: first
    // paint must not wait on grammar chunks.
    void (async () => {
      try {
        await diffs.preloadHighlighter({
          langs: [...CURATED_LANGS],
          themes: [THEME.dark, THEME.light],
        });
      } catch {
        // Highlighting falls back to on-demand per-file loads.
      }
    })();

    const editor = new editMod.Editor("file", {});
    // Draft bookkeeping for the pierre editor: clean text clears the draft.
    const handleEditChange = () => {
      if (!currentPath || !currentEditable) {
        return;
      }
      const text = editor.getText();
      const original = originals.get(currentPath) ?? "";
      if (text === original) {
        drafts.delete(currentPath);
      } else {
        drafts.set(currentPath, text);
      }
      pushError = false;
      syncState();
    };
    const fileView = new File({
      onEditChange: () => {
        handleEditChange();
      },
      overflow: "scroll",
      theme: THEME,
    });
    // Active pierre edit session (dispose before switching files).
    let disposeEdit: (() => void) | undefined;
    let tree: InstanceType<TreesModule["FileTree"]> | undefined;
    onCleanup(() => {
      disposeEdit?.();
      disposeEdit = undefined;
      tree?.cleanUp();
      for (const d of diffViews) {
        d.cleanUp();
      }
      diffViews = [];
      fileView?.cleanUp();
      editor.cleanUp();
    });
    const filePaths = new Set<string>();
    let activePreview = 0;

    // Commit sha of the tree on screen. File contents are addressed by
    // (commit, path), so a cached blob is always right for that commit —
    // reopening a file, or revisiting the page, skips the fetch entirely.
    let treeSha = "";
    const getBlob = async (path: string): Promise<RunnerBlob> => {
      const key = `source:${appId}:blob:${treeSha}:${path}`;
      const hit = treeSha ? readSwr<RunnerBlob>(key) : undefined;
      if (hit) {
        return hit;
      }
      // SAFETY: sourceBlob returns the runner Blob payload which matches RunnerBlob field-for-field; binary/truncated branches are handled by the caller.
      const blob = (await sourceBlob({ appId, path })) as RunnerBlob;
      if (treeSha) {
        writeSwr(key, blob, { persist: false });
      }
      return blob;
    };

    const openFile = async (path: string) => {
      if (aborted()) {
        return;
      }
      if (!filePaths.has(path)) {
        // directory row — nothing to preview
        return;
      }
      activePreview += 1;
      const previewToken = activePreview;
      setMode("files");
      const openSeq = modeSeq;
      try {
        const blob = await getBlob(path);
        if (
          previewToken !== activePreview ||
          openSeq !== modeSeq ||
          aborted()
        ) {
          return;
        }
        currentPath = path;
        // Mirror the open file into the URL (deep-linkable).
        file.set(path);
        // A new file always starts detached; text re-attaches below.
        disposeEdit?.();
        disposeEdit = undefined;
        if (blob.binary || blob.truncated) {
          // Binary/oversize files stay read-only: no edit session, so
          // no draft can form on placeholder text.
          currentEditable = false;
          codeEl.textContent = blob.binary
            ? "(binary file — preview not available)"
            : "(file exceeds 256 KB — preview not available)";
        } else {
          currentEditable = true;
          originals.set(path, blob.text);
          // SAFETY: fileView.render expects { file: { name, contents } }; name/value match the opened path/blob text 1:1.
          // Reopening a dirty file restores its draft, not the preview.
          fileView.render({
            containerWrapper: codeEl,
            file: {
              contents: drafts.get(path) ?? blob.text,
              lang: curatedLang(path, diffs.getFiletypeFromFileName),
              name: path,
            },
          });
          disposeEdit = editor.edit(fileView);
        }
      } catch (error) {
        if (
          previewToken === activePreview &&
          openSeq === modeSeq &&
          !aborted()
        ) {
          codeEl.textContent = errorMessage(error);
        }
      }
    };

    // Tree snapshot (lib/swr-store): a revisit or reload paints the last
    // tree at once, then revalidates and rebuilds only on a new commit.
    const treeKey = `source:${appId}:tree`;
    const fetchTree = async (): Promise<TreeData> => {
      const fresh = await sourceTree(appId);
      writeSwr(treeKey, fresh);
      return fresh;
    };

    // Build the file tree from data (snapshot, fresh fetch, post-push).
    // Returns a default file to open, if any.
    const buildTree = (treeData: TreeData): string | undefined => {
      treeSha = treeData.sha;
      filePaths.clear();
      for (const f of treeData.files) {
        filePaths.add(f.path);
      }
      // Deep link wins when it names a real file; otherwise the
      // Worker config is the sensible default to open — and the
      // tree highlights whichever file lands open.
      const urlFile = file();
      const configFile = [
        "cloudflare.config.ts",
        "wrangler.jsonc",
        "wrangler.toml",
      ].find((name) => filePaths.has(name));
      const initial: string | undefined =
        urlFile && filePaths.has(urlFile) ? urlFile : configFile;
      // Ancestor dirs of the initial file, so deep links land with
      // parents expanded (collapsed parents hide the selection and
      // block the focus scroll).
      const ancestors: string[] = [];
      if (initial) {
        const parts = initial.split("/");
        for (let i = 1; i < parts.length; i += 1) {
          ancestors.push(parts.slice(0, i).join("/"));
        }
      }
      tree?.cleanUp();
      tree = new FileTree({
        initialExpandedPaths: ancestors,
        initialSelectedPaths: initial ? [initial] : undefined,
        onSelectionChange: (selected) => {
          // Late/duplicate selection events (e.g. the initial selection
          // re-firing seconds after mount) must not yank an open diff
          // back to Files — the tree is only actionable in files mode.
          if (selected[0] && currentMode === "files") {
            void openFile(selected[0]);
          }
        },
        preparedInput: preparePresortedFileTreeInput(
          sortTreePaths(treeData.files.map((f) => f.path))
        ),
        search: true,
      });
      tree.render({ fileTreeContainer: treeEl });
      return initial;
    };

    // Commit drafts + push (generic message for now).
    const commit = async () => {
      if (pushing || drafts.size === 0) {
        return;
      }
      pushing = true;
      syncState();
      const files = [...drafts].map(([path, content]) => ({
        content,
        path,
      }));
      try {
        const result = await sourceCommit({
          appId,
          files,
          message: `Web edit: ${files.map((f) => f.path).join(", ")}`,
        });
        if (!result) {
          throw new Error("commit returned nothing");
        }
        for (const [path, content] of drafts) {
          originals.set(path, content);
        }
        drafts.clear();
        const pushed = await fetchTree();
        if (!aborted()) {
          buildTree(pushed);
        }
      } catch {
        pushError = true;
      } finally {
        pushing = false;
        syncState();
      }
    };
    const loadDiff = async (): Promise<void> => {
      if (aborted()) {
        return;
      }
      const diffSeq = modeSeq;
      diffEl.textContent = "";
      for (const d of diffViews) {
        d.cleanUp();
      }
      diffViews = [];
      try {
        const d = await sourceDiff(appId);
        if (aborted() || diffSeq !== modeSeq) {
          return;
        }
        const patches = parsePatchFiles(d.patch);
        for (const patch of patches) {
          for (const fileDiff of patch.files) {
            // SAFETY: pierre's parsed diff files carry { name, lang? } alongside the hunks; the cast only reads an optional string field and writes the same shape back.
            const entry = fileDiff as { name?: unknown; lang?: unknown };
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed patch filenames are untyped vendor data; the string check keeps non-file entries on plain text.
            if (typeof entry.name === "string" && entry.lang === undefined) {
              entry.lang = curatedLang(
                entry.name,
                diffs.getFiletypeFromFileName
              );
            }
            const wrap = document.createElement("div");
            diffEl.append(wrap);
            const instance = new FileDiff({
              diffStyle: "unified",
              theme: THEME,
            });
            instance.render({ containerWrapper: wrap, fileDiff });
            diffViews.push(instance);
          }
        }
        const changed = diffViews.length;
        if (changed === 0) {
          diffEl.textContent =
            d.parent === null
              ? "(initial push — whole tree is new; browse Files)"
              : "(no file changes in the last push)";
        }
      } catch (error) {
        if (!aborted() && diffSeq === modeSeq) {
          diffEl.textContent = errorMessage(error);
        }
      }
    };
    try {
      const snapshot = readSwr<TreeData>(treeKey);
      // Paint whatever we have first: the stored tree (and its cached
      // default file) needs no network at all.
      const showInitial = async (initial: string | undefined) => {
        // Deep links / refreshes with ?view=diff land straight in the diff.
        if (currentMode === "diff") {
          setMode("diff");
          await loadDiff();
        } else if (initial) {
          await openFile(initial);
        }
      };
      if (snapshot) {
        await showInitial(buildTree(snapshot));
        if (aborted()) {
          return;
        }
      }
      const fresh = await fetchTree();
      if (aborted()) {
        return;
      }
      if (!snapshot || fresh.sha !== snapshot.sha) {
        // Cold, or a push landed since the snapshot: (re)build and reopen.
        await showInitial(buildTree(fresh));
      }
      syncState();
    } catch (error) {
      treeEl.textContent = "";
      codeEl.textContent = errorMessage(error);
    }

    box.api.show = (next) => {
      if (next === "diff") {
        setMode("diff");
        void loadDiff();
      } else {
        setMode("files");
      }
    };
    box.api.commit = () => {
      void commit();
    };
    // A Files/Diff toggle clicked while the libs were still loading hit
    // the no-op api — catch up with the mode the page holds now.
    if (mode() !== currentMode) {
      box.api.show(mode());
    }
  });

  const showFiles = mode() === "files";
  return (
    <div class="flex min-h-0 w-full flex-1 flex-col gap-2">
      <div class="flex min-h-0 min-w-0 flex-1 gap-4">
        <div
          ref={attach("tree")}
          class={`noite-src-tree bg-base-200/50 min-h-0 w-72 shrink-0 overflow-auto pt-2 ${showFiles ? "" : "hidden"}`}
        ></div>
        <div
          ref={attach("code")}
          class={`min-h-0 min-w-0 flex-1 overflow-auto ${showFiles ? "" : "hidden"}`}
        ></div>
        <div
          ref={attach("diff")}
          class={`min-h-0 min-w-0 flex-1 overflow-auto ${showFiles ? "hidden" : ""}`}
        ></div>
      </div>
    </div>
  );
};
