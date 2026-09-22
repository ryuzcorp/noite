/**
 * Source browser: file tree (@pierre/trees) + code preview / last-push diff
 * (@pierre/diffs), both mounted imperatively from their vanilla APIs.
 *
 * ilha has no element refs and re-renders on atom reads, so this component:
 *   - reads NO atoms in JSX (the skeleton only emits hosts + empty containers),
 *   - does all work inside watch.once() (client-only, once per mount),
 *   - spins the libs up on plain DOM nodes, which never get repatched.
 *
 * Data comes from the runner's bare-mirror endpoints via server-side actions
 * (sourceTree / sourceBlob / sourceDiff) — the browser never sees tokens.
 */
import type { EditorChangeEvent, EditorOptions } from "@pierre/diffs/edit";
import { watch } from "ilha";

import {
  sourceBlob,
  sourceCommit,
  sourceDiff,
  sourceTree,
} from "./apps.server";
import type { RunnerBlob } from "./runner";
import { sleep } from "./sleep";

const waitEl = async (id: string, tries = 60): Promise<HTMLElement | null> => {
  for (let i = 0; i < tries; i += 1) {
    const el = document.querySelector(`#${id}`);
    if (el instanceof HTMLElement) {
      return el;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential DOM-poll; each attempt must see the result of the previous wait
    await sleep(50);
  }
  return null;
};

const fmtSize = (n: number) =>
  n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

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
    file: { contents: string; name: string };
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
}

export type SourceMode = "files" | "diff";

/** Pending mode switch (set on mount, cleared on unmount). Lets the page
 * header drive the browser without atoms crossing the imperative boundary. */
let modeRequest: ((mode: SourceMode) => void) | undefined;

/** Ask the mounted browser to show Files or the last-push diff. */
export const requestSourceMode = (mode: SourceMode) => {
  modeRequest?.(mode);
};

/** Pending push trigger (set on mount, cleared on unmount). The page's
 * Push button fires through here so no atoms cross into page JSX
 * (a parent re-render would remount this browser). */
let pushNow: (() => void) | undefined;

/** Ask the mounted browser to commit + push dirty files. */
export const requestSourcePush = () => {
  pushNow?.();
};

/** Header toggle styling, synced imperatively by id (see setMode). */
const syncToggle = (showFiles: boolean) => {
  const filesBtn = document.querySelector("#noite-src-view-files");
  const diffBtn = document.querySelector("#noite-src-view-diff");
  filesBtn?.classList.toggle("btn-neutral", showFiles);
  filesBtn?.classList.toggle("btn-ghost", !showFiles);
  diffBtn?.classList.toggle("btn-neutral", !showFiles);
  diffBtn?.classList.toggle("btn-ghost", showFiles);
};

// The status line is gone from the layout — a no-op sink so the
// load/error call sites in the setup stay intact.
const setStatus = (s: string): void => {
  void s;
};

/** Mount generation — each setup takes the next number. Stale async
 * continuations (remounts, HMR, slow fetches resolving late) compare
 * against it and abort instead of clobbering the live UI. Bumped on
 * setup start and on unmount cleanup. */
let setupGen = 0;

export const SourceBrowser = ({ appId }: { appId: string }) => {
  watch.once(() => {
    if (typeof document === "undefined") {
      return;
    }
    // Cleanup is created inside the async setup — expose it for unmount via
    // the documented contract (watch.once returns a cleanup).
    // SAFETY: fn starts unset (undefined) and is only ever assigned the real cleanup once the async setup completes.
    const teardown = { fn: undefined as (() => void) | undefined };
    void (async () => {
      setupGen += 1;
      const gen = setupGen;
      const treeRoot = await waitEl("noite-src-tree");
      const codeHost = await waitEl("noite-src-code");
      const diffHost = await waitEl("noite-src-diff");
      if (!treeRoot || !codeHost || !diffHost) {
        return;
      }

      let currentMode: SourceMode = "files";
      let modeSeq = 0;
      // Drafts live here (never in atoms): the page must not re-render
      // (see its NOTE), so every control syncs imperatively. The code
      // pane is always pierre-editable — no edit mode, no toggle.
      let pushing = false;
      let pushError = false;
      let currentPath: string | null = null;
      let currentEditable = false;
      const drafts = new Map<string, string>();
      const originals = new Map<string, string>();
      // Header toggle shares no atoms with this component (a parent
      // subscription would remount this browser on every switch), so
      // its styling syncs imperatively by id like the status line.
      const setMode = (mode: SourceMode) => {
        modeSeq += 1;
        currentMode = mode;
        const showFiles = mode === "files";
        treeRoot.classList.toggle("hidden", !showFiles);
        codeHost.classList.toggle("hidden", !showFiles);
        diffHost.classList.toggle("hidden", showFiles);
        syncToggle(showFiles);
      };
      // Push button state: label + disabled, synced by id.
      const syncPushButton = () => {
        const btn = document.querySelector("#noite-src-push");
        if (!(btn instanceof HTMLButtonElement)) {
          return;
        }
        const n = drafts.size;
        btn.disabled = n === 0 || pushing;
        if (pushing) {
          btn.textContent = "Pushing…";
        } else if (pushError) {
          btn.textContent = "Push failed — retry";
        } else if (n > 0) {
          btn.textContent = `Push (${n})`;
        } else {
          btn.textContent = "Push";
        }
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
        setStatus(
          "@pierre/trees + @pierre/diffs not installed — run `bun install` in apps/noite"
        );
        return;
      }
      const { FileTree, preparePresortedFileTreeInput } = trees;
      const { File, FileDiff, parsePatchFiles } = diffs;

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
        syncPushButton();
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
      teardown.fn = () => {
        disposeEdit?.();
        disposeEdit = undefined;
        tree?.cleanUp();
        for (const d of diffViews) {
          d.cleanUp();
        }
        diffViews = [];
        fileView?.cleanUp();
        editor.cleanUp();
      };
      const filePaths = new Set<string>();
      let activePreview = 0;

      const openFile = async (path: string) => {
        if (gen !== setupGen) {
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
        setStatus(`loading ${path} …`);
        try {
          // SAFETY: sourceBlob returns the runner Blob payload which matches RunnerBlob field-for-field; binary/truncated branches are handled below.
          const blob = (await sourceBlob({ appId, path })) as RunnerBlob;
          if (
            previewToken !== activePreview ||
            openSeq !== modeSeq ||
            gen !== setupGen
          ) {
            return;
          }
          currentPath = path;
          // Mirror the open file into the URL (deep-linkable, no history
          // spam — same replaceState pattern as the D1 filters).
          const fileParams = new URLSearchParams(window.location.search);
          fileParams.set("file", path);
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}?${fileParams.toString()}`
          );
          // A new file always starts detached; text re-attaches below.
          disposeEdit?.();
          disposeEdit = undefined;
          if (blob.binary || blob.truncated) {
            // Binary/oversize files stay read-only: no edit session, so
            // no draft can form on placeholder text.
            currentEditable = false;
            codeHost.textContent = blob.binary
              ? "(binary file — preview not available)"
              : "(file exceeds 256 KB — preview not available)";
          } else {
            currentEditable = true;
            originals.set(path, blob.text);
            // SAFETY: fileView.render expects { file: { name, contents } }; name/value match the opened path/blob text 1:1.
            // Reopening a dirty file restores its draft, not the preview.
            fileView.render({
              containerWrapper: codeHost,
              file: { contents: drafts.get(path) ?? blob.text, name: path },
            });
            disposeEdit = editor.edit(fileView);
          }
          setStatus(`${path} · ${fmtSize(blob.size)}`);
        } catch (error) {
          if (
            previewToken === activePreview &&
            openSeq === modeSeq &&
            gen === setupGen
          ) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        }
      };

      // Rebuild the file tree (initial mount + post-push refresh).
      // Returns a default file to open, if any.
      const loadTree = async (): Promise<string | undefined> => {
        const treeData = await sourceTree(appId);
        if (gen !== setupGen) {
          return undefined;
        }
        setStatus(
          `${treeData.files.length} file(s) @ ${treeData.sha.slice(0, 12)}`
        );
        filePaths.clear();
        for (const f of treeData.files) {
          filePaths.add(f.path);
        }
        // Deep link wins when it names a real file; otherwise the
        // wrangler manifest is the sensible default to open — and the
        // tree highlights whichever file lands open.
        const urlFile = new URLSearchParams(window.location.search).get("file");
        let initial: string | undefined;
        if (urlFile && filePaths.has(urlFile)) {
          initial = urlFile;
        } else if (filePaths.has("wrangler.jsonc")) {
          initial = "wrangler.jsonc";
        } else if (filePaths.has("wrangler.toml")) {
          initial = "wrangler.toml";
        }
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
        tree.render({ fileTreeContainer: treeRoot });
        return initial;
      };

      // Commit drafts + push (generic message for now).
      const commit = async () => {
        if (pushing || drafts.size === 0) {
          return;
        }
        pushing = true;
        syncPushButton();
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
          const { sha } = result;
          for (const [path, content] of drafts) {
            originals.set(path, content);
          }
          drafts.clear();
          await loadTree();
          setStatus(`pushed ${sha.slice(0, 12)} — deploy follows the tip`);
        } catch (error) {
          pushError = true;
          setStatus(error instanceof Error ? error.message : String(error));
        } finally {
          pushing = false;
          syncPushButton();
        }
      };

      try {
        const defaultPreviewPath = await loadTree();
        if (defaultPreviewPath) {
          await openFile(defaultPreviewPath);
        }
      } catch (error) {
        treeRoot.textContent = "";
        setStatus(error instanceof Error ? error.message : String(error));
      }

      const loadDiff = async () => {
        if (gen !== setupGen) {
          return;
        }
        const diffSeq = modeSeq;
        setStatus("loading last-push diff …");
        diffHost.textContent = "";
        for (const d of diffViews) {
          d.cleanUp();
        }
        diffViews = [];
        try {
          const d = await sourceDiff(appId);
          if (gen !== setupGen || diffSeq !== modeSeq) {
            return;
          }
          const patches = parsePatchFiles(d.patch);
          for (const patch of patches) {
            for (const fileDiff of patch.files) {
              const wrap = document.createElement("div");
              diffHost.append(wrap);
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
            diffHost.textContent =
              d.parent === null
                ? "(initial push — whole tree is new; browse Files)"
                : "(no file changes in the last push)";
          }
          setStatus(
            `${changed} file(s) changed · ${d.sha.slice(0, 12)}${d.truncated ? " · patch truncated" : ""}`
          );
        } catch (error) {
          if (gen === setupGen && diffSeq === modeSeq) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        }
      };
      if (gen !== setupGen) {
        return;
      }
      modeRequest = (mode) => {
        if (mode === "diff") {
          setMode("diff");
          void loadDiff();
        } else {
          setMode("files");
        }
      };
      pushNow = () => {
        void commit();
      };
      // Deep links / refreshes with ?view=diff land straight in the diff.
      if (new URLSearchParams(window.location.search).get("view") === "diff") {
        setMode("diff");
        void loadDiff();
      }
    })();
    return () => {
      modeRequest = undefined;
      pushNow = undefined;
      setupGen += 1;
      teardown.fn?.();
    };
  });

  return (
    <div class="flex min-h-0 w-full flex-1 flex-col gap-2">
      <div class="flex min-h-0 min-w-0 flex-1 gap-4">
        <div
          id="noite-src-tree"
          class="bg-base-200/50 min-h-0 w-72 shrink-0 overflow-auto pt-2"
        ></div>
        <div
          id="noite-src-code"
          class="min-h-0 min-w-0 flex-1 overflow-auto"
        ></div>
        <div
          id="noite-src-diff"
          class="hidden min-h-0 min-w-0 flex-1 overflow-auto"
        ></div>
      </div>
    </div>
  );
};
