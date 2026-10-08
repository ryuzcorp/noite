/**
 * Diff viewers: patches for the commit and compare pages, and the source
 * page's unpushed drafts. `@pierre/diffs`'s FileDiff mounted imperatively
 * into a shadow pane (like the source browser — the shadow root survives
 * ilha's morph, which would otherwise delete pierre's nodes). Mount a view
 * once per input (`key`); it renders on mount.
 */
import { atom, watch } from "ilha";

import { collectRef, newLiveRef, whenLive } from "../live-ref";
import { CURATED_SHIKI_LANGS } from "../shiki-langs";

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

/** A highlight language for `name`, capped to the curated set. */
const langFor = (diffs: DiffsModule, name: string): string => {
  const lang = diffs.getFiletypeFromFileName(name);
  return CURATED_SHIKI_LANGS.includes(lang) ? lang : "text";
};

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

/** Mounts pierre, then one FileDiff per entry `entries` builds. */
const PierreDiffs = ({
  emptyLabel,
  entries,
}: {
  emptyLabel: string;
  entries: (diffs: DiffsModule) => PatchFileEntry[];
}) => {
  const host = atom.lazy(() => newLiveRef<HTMLDivElement>())();
  watch.once(async ({ onCleanup, signal }) => {
    const el = await whenLive(host, signal);
    if (signal.aborted || !el) {
      return;
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
    } catch {
      pane.textContent =
        "@pierre/diffs not installed — run `bun install` in apps/noite";
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

/** A unified patch (commit, compare, pull request). */
export const DiffView = ({
  emptyLabel,
  patch,
}: {
  /** Shown when the patch parses to no files (e.g. an empty commit). */
  emptyLabel: string;
  patch: string;
}) => (
  <PierreDiffs
    emptyLabel={emptyLabel}
    entries={(diffs) =>
      diffs.parsePatchFiles(patch).flatMap((parsed) =>
        parsed.files.map((fileDiff) => {
          // SAFETY: parsed patch entries carry { name, lang? }; the string check
          // keeps non-file entries on plain text (same guard as the browser).
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed patch filenames are untyped vendor data; the string check keeps non-file entries on plain text.
          const name = typeof fileDiff.name === "string" ? fileDiff.name : null;
          if (name !== null && fileDiff.lang === undefined) {
            fileDiff.lang = langFor(diffs, name);
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
    entries={(diffs) =>
      files.map(({ after, before, path }) => {
        const lang = langFor(diffs, path);
        return diffs.parseDiffFromFile(
          { contents: before, lang, name: path },
          { contents: after, lang, name: path }
        );
      })
    }
  />
);
