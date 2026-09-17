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
import { watch } from "ilha";

import { sourceBlob, sourceDiff, sourceTree } from "./apps.server";
import type { RunnerBlob } from "./runner";

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- the browser has no timers/promises; a setTimeout-based delay needs a fresh Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

interface DiffsModule {
  File: new (opts?: { theme?: unknown; overflow?: string }) => {
    render: (opts: {
      file: { name: string; contents: string };
      containerWrapper: HTMLElement | null;
    }) => void;
    cleanUp: () => void;
  };
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

/** Header toggle styling, synced imperatively by id (see setMode). */
const syncToggle = (showFiles: boolean) => {
  const filesBtn = document.querySelector("#noite-src-view-files");
  const diffBtn = document.querySelector("#noite-src-view-diff");
  filesBtn?.classList.toggle("btn-neutral", showFiles);
  filesBtn?.classList.toggle("btn-ghost", !showFiles);
  diffBtn?.classList.toggle("btn-neutral", !showFiles);
  diffBtn?.classList.toggle("btn-ghost", showFiles);
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
      const statusEl = await waitEl("noite-src-status");
      if (!treeRoot || !codeHost || !diffHost || !statusEl) {
        return;
      }

      const setStatus = (s: string) => {
        statusEl.textContent = s;
      };

      let currentMode: SourceMode = "files";
      let modeSeq = 0;
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

      let diffViews: { cleanUp: () => void }[] = [];

      let trees: TreesModule;
      let diffs: DiffsModule;
      try {
        const modulesPromise = Promise.all([
          import("@pierre/trees"),
          import("@pierre/diffs"),
        ]);
        // SAFETY: import() resolves the installed @pierre modules which structurally match TreesModule/DiffsModule.
        const loaded = (await modulesPromise) as [TreesModule, DiffsModule];
        const [treesMod, diffsMod] = loaded;
        trees = treesMod;
        diffs = diffsMod;
      } catch {
        setStatus(
          "@pierre/trees + @pierre/diffs not installed — run `bun install` in apps/noite"
        );
        return;
      }
      const { FileTree, preparePresortedFileTreeInput } = trees;
      const { File, FileDiff, parsePatchFiles } = diffs;

      const fileView = new File({ overflow: "scroll", theme: THEME });
      let tree: { cleanUp: () => void } | undefined;
      teardown.fn = () => {
        tree?.cleanUp();
        for (const d of diffViews) {
          d.cleanUp();
        }
        diffViews = [];
        fileView?.cleanUp();
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
          if (blob.binary) {
            codeHost.textContent = "(binary file — preview not available)";
          } else if (blob.truncated) {
            codeHost.textContent =
              "(file exceeds 256 KB — preview not available)";
          } else {
            // SAFETY: fileView.render expects { file: { name, contents } }; name/value match the opened path/blob text 1:1.
            fileView.render({
              containerWrapper: codeHost,
              file: { contents: blob.text, name: path },
            });
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

      try {
        const treeData = await sourceTree(appId);
        setStatus(
          `${treeData.files.length} file(s) @ ${treeData.sha.slice(0, 12)}`
        );
        for (const f of treeData.files) {
          filePaths.add(f.path);
        }
        let defaultPreviewPath: string | undefined;
        if (filePaths.has("wrangler.jsonc")) {
          defaultPreviewPath = "wrangler.jsonc";
        } else if (filePaths.has("wrangler.toml")) {
          defaultPreviewPath = "wrangler.toml";
        }
        tree = new FileTree({
          initialSelectedPaths: defaultPreviewPath
            ? [defaultPreviewPath]
            : undefined,
          onSelectionChange: (selected) => {
            // Late/duplicate selection events (e.g. the initial selection
            // re-firing seconds after mount) must not yank an open diff
            // back to Files — the tree is only actionable in files mode.
            if (selected[0] && currentMode === "files") {
              void openFile(selected[0]);
            }
          },
          preparedInput: preparePresortedFileTreeInput(
            treeData.files.map((f) => f.path)
          ),
          search: true,
        });
        tree.render({ fileTreeContainer: treeRoot });
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
      // Deep links / refreshes with ?view=diff land straight in the diff.
      if (new URLSearchParams(window.location.search).get("view") === "diff") {
        setMode("diff");
        void loadDiff();
      }
    })();
    return () => {
      modeRequest = undefined;
      setupGen += 1;
      teardown.fn?.();
    };
  });

  return (
    <div class="flex min-h-0 w-full flex-1 flex-col gap-2">
      <div class="border-base-300 flex min-h-[50vh] flex-1 overflow-hidden rounded-lg border">
        <div
          id="noite-src-tree"
          class="bg-base-200/50 w-72 shrink-0 overflow-auto p-2"
        ></div>
        <div id="noite-src-code" class="min-w-0 flex-1 overflow-auto"></div>
        <div
          id="noite-src-diff"
          class="hidden min-w-0 flex-1 overflow-auto"
        ></div>
      </div>
      <p class="m-0 text-xs opacity-60">
        <span id="noite-src-status" class="font-medium"></span>
        {
          " Preview of the latest pushed commit, served from the runner's bare mirror."
        }
      </p>
    </div>
  );
};
