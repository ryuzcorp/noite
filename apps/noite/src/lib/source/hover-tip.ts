//! The source pane's hover tip: the floating quick-info / declaration /
//! diagnostics container the editor's token hooks drive. TypeScript output only
//! ever becomes text nodes; the highlighting is per-token spans, never HTML.

import type {
  codeToTokens,
  isSupportedLanguage,
  Theme as HighlightsTheme,
  ThemedToken,
} from "@pierre/highlights";

/** The pointer rests on a token this long before its hover tip opens, the
 * same delay pierre uses for its diagnostic popovers. */
export const HOVER_DELAY = 300;

/** How long a tip stays up after the pointer leaves its token or the tip
 * itself: long enough to cross the gap between them, so the tip can be
 * hovered, scrolled and its text selected. */
const HIDE_GRACE = 200;

/** Pierre's token color variables (`--diffs-token-light` / `-dark`): the tip
 * highlights with the same prefix, so its colors follow the editor's theme. */
const TOKEN_VAR_PREFIX = "--diffs-token-";

/** What a hover tip shows: code highlighted as `lang`, an optional plain
 * header above it, plain doc lines under it and — last, under a divider — the
 * diagnostics covering the token. Type info and errors share this one floating
 * container, so a token with both never stacks two overlapping popups. */
export interface TipContent {
  code: string;
  docs: readonly string[];
  /** Diagnostic messages for the token, in the order the worker reported them. */
  errors: readonly string[];
  header?: string;
  lang: string;
}

/** The hover tip: quick info, or the declaration lines of a definition the
 * pane cannot open. TypeScript output only ever becomes text nodes; the
 * highlighting is per-token spans, never HTML. */
export interface HoverTip {
  /** Take the tip's node out of the pane: the shadow root (and the pane in
   * it) outlives this wiring, so a mount that does not remove its tip leaves
   * one behind for the next one to stack on. */
  dispose: () => void;
  /** Close it now: the file changed or the editor closed. */
  hide: () => void;
  /** The pointer left the token: close it unless the pointer reaches the
   * tip within `HIDE_GRACE`. */
  leave: () => void;
  show: (content: TipContent, anchor: HTMLElement) => Promise<void>;
}

/** The slice of `@pierre/highlights` the tip uses, with Pierre's two themes. */
interface TipHighlighter {
  codeToTokens: typeof codeToTokens;
  isSupportedLanguage: typeof isSupportedLanguage;
  themes: { dark: HighlightsTheme; light: HighlightsTheme };
}

/** Loaded with the first tip that has code: the lexers are one WebAssembly
 * module, so the editor's own load never pays for it. */
const loadHighlighter = async (): Promise<TipHighlighter> => {
  const [highlights, dark, light] = await Promise.all([
    import("@pierre/highlights"),
    import("@pierre/highlights/themes/pierre-dark"),
    import("@pierre/highlights/themes/pierre-light"),
  ]);
  return {
    codeToTokens: highlights.codeToTokens,
    isSupportedLanguage: highlights.isSupportedLanguage,
    themes: { dark: dark.default, light: light.default },
  };
};
let highlighterLoad: Promise<TipHighlighter> | undefined;

/** `code` as one span per token, colored through pierre's variables; plain
 * text when the highlighter is unavailable or does not know `lang`. */
const highlightInto = async (
  el: HTMLElement,
  { code, lang }: TipContent
): Promise<void> => {
  let lines: ThemedToken[][];
  try {
    highlighterLoad ??= loadHighlighter();
    const highlighter = await highlighterLoad;
    ({ tokens: lines } = highlighter.codeToTokens(code, {
      cssVariablePrefix: TOKEN_VAR_PREFIX,
      defaultColor: false,
      lang: highlighter.isSupportedLanguage(lang) ? lang : "plain",
      themes: highlighter.themes,
    }));
  } catch {
    highlighterLoad = undefined;
    el.textContent = code;
    return;
  }
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      el.append("\n");
    }
    for (const token of line) {
      const span = document.createElement("span");
      span.textContent = token.content;
      for (const [name, value] of Object.entries(token.htmlStyle ?? {})) {
        span.style.setProperty(name, value);
      }
      el.append(span);
    }
  }
};

export const createHoverTip = (pane: HTMLElement): HoverTip => {
  const tip = document.createElement("div");
  tip.className = "intel-tip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  // `pane` is the pane itself, not the container a paint wipes: the tip
  // outlives every placeholder, note and open error (see `pane.ts`).
  pane.append(tip);
  // Every show/hide bumps this; a show still highlighting when a newer call
  // lands must not open.
  let generation = 0;
  let hideTimer: number | undefined;
  const cancelHide = () => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  const hide = () => {
    cancelHide();
    generation += 1;
    tip.hidden = true;
  };
  const leave = () => {
    // A show still highlighting for the token just left must not open.
    generation += 1;
    cancelHide();
    if (!tip.hidden) {
      hideTimer = window.setTimeout(hide, HIDE_GRACE);
    }
  };
  tip.addEventListener("pointerenter", cancelHide);
  tip.addEventListener("pointerleave", leave);
  return {
    dispose: () => {
      // The pane (and its shadow root) outlives this wiring, so the node has
      // to go with it or the next mount appends a second one.
      hide();
      tip.remove();
    },
    hide,
    leave,
    show: async (content, anchor) => {
      cancelHide();
      generation += 1;
      const mine = generation;
      const body = document.createElement("div");
      if (content.header) {
        const head = document.createElement("div");
        head.className = "intel-head";
        head.textContent = content.header;
        body.append(head);
      }
      if (content.code !== "") {
        const code = document.createElement("div");
        code.className = "intel-code";
        await highlightInto(code, content);
        body.append(code);
      }
      if (content.docs.length > 0) {
        const docs = document.createElement("div");
        docs.className = "intel-docs";
        docs.textContent = content.docs.join("\n");
        body.append(docs);
      }
      if (content.errors.length > 0) {
        const errors = document.createElement("div");
        errors.className = "intel-errors";
        errors.textContent = content.errors.join("\n");
        body.append(errors);
      }
      if (mine !== generation || !anchor.isConnected) {
        return;
      }
      tip.replaceChildren(...body.childNodes);
      tip.hidden = false;
      const paneBox = pane.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      // Clamp into the pane: the tip must not introduce horizontal scroll.
      const left = Math.max(
        0,
        Math.min(
          anchorBox.left - paneBox.left,
          pane.clientWidth - tip.offsetWidth - 8
        )
      );
      tip.style.left = `${left}px`;
      tip.style.top = `${anchorBox.bottom - paneBox.top + 4}px`;
    },
  };
};
