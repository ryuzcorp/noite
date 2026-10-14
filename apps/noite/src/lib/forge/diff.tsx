/**
 * Diff viewers: patches for the commit and compare pages, and the source
 * page's unpushed drafts. `@pierre/diffs`'s FileDiff mounted imperatively
 * into a shadow pane (like the source browser — the shadow root survives
 * ilha's morph, which would otherwise delete pierre's nodes). Mount a view
 * once per input (`key`); it renders on mount.
 */
import { atom, watch } from "ilha";

import { errorMessage } from "../errors";
import { collectRef, newLiveRef, whenLive } from "../live-ref";
import { CURATED_SHIKI_LANGS, curatedLang } from "../shiki-langs";

const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

/** The parsed patch file entries are untyped vendor data. */
interface PatchFileEntry {
  name?: unknown;
  lang?: unknown;
}

interface ParsedPatch {
  files: PatchFileEntry[];
}

interface FileDiffInstance {
  render: (opts: {
    containerWrapper: HTMLElement;
    fileDiff: PatchFileEntry;
  }) => void;
  cleanUp: () => void;
}

interface DiffsModule {
  FileDiff: new (opts?: {
    diffStyle?: string;
    /** `wrap` breaks long lines into view instead of clipping them (the
     * Changes panel diff is wide-content in a narrow pane). */
    overflow?: "scroll" | "wrap";
    theme?: unknown;
  }) => FileDiffInstance;
  getFiletypeFromFileName: (filename: string) => string;
  parseDiffFromFile: (
    oldFile: { contents: string; lang: string; name: string },
    newFile: { contents: string; lang: string; name: string }
  ) => PatchFileEntry;
  parsePatchFiles: (patch: string) => ParsedPatch[];
  preloadHighlighter: (opts: {
    langs: string[];
    themes: string[];
  }) => Promise<void>;
}

/** Fill the host and stretch the content-sized diff to the pane height. */
const PANE_CSS = `
:host { display: block; }
.pane { display: flex; flex-direction: column; min-height: 100%; }
.pane > * { flex: 1; min-height: 100%; }
`;

/** The shadow mount point on `host` (created once). */
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

/** The line a click landed on, read from pierre's rows: content rows carry
 * `data-line`, gutter rows `data-column-number`, both with `data-line-type`.
 * A composed-path walk, so it also sees nodes inside pierre's shadow root. */
export const diffLineFromEvent = (
  event: MouseEvent
): { line: number; side: "old" | "new" } | null => {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const raw = node.dataset.line ?? node.dataset.columnNumber;
    if (raw === undefined) {
      continue;
    }
    const line = Math.trunc(Number(raw));
    if (!Number.isSafeInteger(line) || line <= 0) {
      continue;
    }
    return {
      line,
      side: (node.dataset.lineType ?? "").includes("deletion") ? "old" : "new",
    };
  }
  return null;
};

/** Mounts pierre, then one FileDiff per entry `entries` builds. */
const PierreDiffs = ({
  emptyLabel,
  entries,
  onLineClick,
  overflow = "scroll",
}: {
  emptyLabel: string;
  entries: (diffs: DiffsModule) => PatchFileEntry[];
  onLineClick?: (hit: { line: number; side: "old" | "new" }) => void;
  overflow?: "scroll" | "wrap";
}) => {
  const host = atom.lazy(() => newLiveRef<HTMLDivElement>())();
  watch.once(async ({ onCleanup, signal }) => {
    const el = await whenLive(host, signal);
    if (signal.aborted || !el) {
      return;
    }
    if (onLineClick) {
      el.addEventListener(
        "click",
        (event) => {
          if (!window.getSelection()?.isCollapsed) {
            return;
          }
          const hit = diffLineFromEvent(event);
          if (hit) {
            onLineClick(hit);
          }
        },
        { signal }
      );
    }
    const pane = paneIn(el);
    let diffs: DiffsModule;
    try {
      // Canonical modules only load here: a static import would carry the
      // whole syntax highlighter into every page's entry chunk, and
      // @pierre/diffs resolves its grammars through dynamic imports anyway.
      // SAFETY: import() resolves the installed @pierre/diffs, which structurally matches DiffsModule.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- vendor types drift from the minimal local interfaces; unknown bridges them.
      diffs = (await import("@pierre/diffs")) as unknown as DiffsModule;
    } catch (error) {
      pane.textContent = `The diff viewer failed to load: ${errorMessage(error)}. Reload the page to retry.`;
      return;
    }
    if (signal.aborted) {
      return;
    }
    void (async () => {
      try {
        await diffs.preloadHighlighter({
          langs: [...CURATED_SHIKI_LANGS],
          themes: [THEME.dark, THEME.light],
        });
      } catch {
        // Falls back to on-demand per-file grammar loads.
      }
    })();
    const views: FileDiffInstance[] = [];
    for (const fileDiff of entries(diffs)) {
      const wrap = document.createElement("div");
      pane.append(wrap);
      const instance = new diffs.FileDiff({
        diffStyle: "unified",
        overflow,
        theme: THEME,
      });
      instance.render({ containerWrapper: wrap, fileDiff });
      views.push(instance);
    }
    if (views.length === 0) {
      pane.textContent = emptyLabel;
    }
    onCleanup(() => {
      for (const view of views) {
        view.cleanUp();
      }
    });
  });
  return (
    <div
      ref={(el) => {
        collectRef(host, el);
      }}
      class="block w-full"
    ></div>
  );
};

/** A unified patch (commit, compare, pull request). With `onLineClick`, a
 * click on a line number (gutter) or content row reports the line it hit, so
 * a caller can anchor a comment there. */
export const DiffView = ({
  emptyLabel,
  onLineClick,
  patch,
}: {
  /** Shown when the patch parses to no files (e.g. an empty commit). */
  emptyLabel: string;
  /** Called with the clicked line (not when text is selected). */
  onLineClick?: (hit: { line: number; side: "old" | "new" }) => void;
  patch: string;
}) => (
  <PierreDiffs
    emptyLabel={emptyLabel}
    onLineClick={onLineClick}
    entries={(diffs) =>
      diffs.parsePatchFiles(patch).flatMap((parsed) =>
        parsed.files.map((fileDiff) => {
          // SAFETY: parsed patch entries carry { name, lang? }; the string check
          // keeps non-file entries on plain text (same guard as the browser).
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed patch filenames are untyped vendor data; the string check keeps non-file entries on plain text.
          const name = typeof fileDiff.name === "string" ? fileDiff.name : null;
          if (name !== null && fileDiff.lang === undefined) {
            fileDiff.lang = curatedLang(name, diffs.getFiletypeFromFileName);
          }
          return fileDiff;
        })
      )
    }
  />
);

/** Unpushed edits: each file's text at the browsed commit against its draft. */
export const DraftDiffView = ({
  emptyLabel,
  files,
}: {
  emptyLabel: string;
  files: readonly { after: string; before: string; path: string }[];
}) => (
  <PierreDiffs
    emptyLabel={emptyLabel}
    // The panel is a narrow column of wide lines: wrap so an edit at the end
    // of a long line is visible instead of clipped.
    overflow="wrap"
    entries={(diffs) =>
      files.map(({ after, before, path }) => {
        const lang = curatedLang(path, diffs.getFiletypeFromFileName);
        return diffs.parseDiffFromFile(
          { contents: before, lang, name: path },
          { contents: after, lang, name: path }
        );
      })
    }
  />
);
