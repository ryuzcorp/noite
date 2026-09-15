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
      const actionHost = await waitEl("noite-src-actions");
      const treeRoot = await waitEl("noite-src-tree");
      const codeHost = await waitEl("noite-src-code");
      const diffHost = await waitEl("noite-src-diff");
      if (!actionHost || !treeRoot || !codeHost || !diffHost) {
        return;
      }

      const statusEl = document.createElement("span");
      statusEl.className = "text-xs opacity-70 ml-auto";
      const setStatus = (s: string) => {
        statusEl.textContent = s;
      };
      actionHost.append(statusEl);

      const btnFiles = document.createElement("button");
      btnFiles.type = "button";
      btnFiles.className = "btn btn-sm btn-primary";
      btnFiles.textContent = "Files";
      const btnDiff = document.createElement("button");
      btnDiff.type = "button";
      btnDiff.className = "btn btn-sm btn-ghost";
      btnDiff.textContent = "Last push diff";
      statusEl.before(btnFiles);
      statusEl.before(btnDiff);

      const setMode = (mode: "files" | "diff") => {
        const showFiles = mode === "files";
        treeRoot.classList.toggle("hidden", !showFiles);
        codeHost.classList.toggle("hidden", !showFiles);
        diffHost.classList.toggle("hidden", showFiles);
        btnFiles.classList.toggle("btn-primary", showFiles);
        btnFiles.classList.toggle("btn-ghost", !showFiles);
        btnDiff.classList.toggle("btn-primary", !showFiles);
        btnDiff.classList.toggle("btn-ghost", showFiles);
      };
      btnFiles.addEventListener("click", () => setMode("files"));
      btnDiff.addEventListener("click", () => setMode("diff"));

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
        if (!filePaths.has(path)) {
          // directory row — nothing to preview
          return;
        }
        activePreview += 1;
        const previewToken = activePreview;
        setMode("files");
        setStatus(`loading ${path} …`);
        try {
          // SAFETY: sourceBlob returns the runner Blob payload which matches RunnerBlob field-for-field; binary/truncated branches are handled below.
          const blob = (await sourceBlob({ appId, path })) as RunnerBlob;
          if (previewToken !== activePreview) {
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
          setStatus(error instanceof Error ? error.message : String(error));
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
            if (selected[0]) {
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

      btnDiff.addEventListener("click", async () => {
        setMode("diff");
        setStatus("loading last-push diff …");
        diffHost.textContent = "";
        for (const d of diffViews) {
          d.cleanUp();
        }
        diffViews = [];
        try {
          const d = await sourceDiff(appId);
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
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    })();
    return () => teardown.fn?.();
  });

  return (
    <div class="flex flex-col gap-2">
      <div id="noite-src-actions" class="flex min-h-9 items-center gap-2"></div>
      <div class="border-base-300 flex h-[65vh] overflow-hidden rounded-lg border">
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
        Preview of the latest pushed commit, served from the runner&apos;s bare
        mirror.
      </p>
    </div>
  );
};
