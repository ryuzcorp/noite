//! Shadow-pane plumbing shared by both source panes: the theme pair the pierre
//! mounts render with, the styles each pane's shadow root wears, and the mount
//! point pierre renders into — a shadow root on the host, because ilha's morph
//! rewrites a host's light DOM (and attributes) on every re-render.

export const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

/** Styles inside each pane's shadow root: fill the host, stretch the
 * content-sized pierre element so short files still fill the code area, and
 * dress the hover tip (which lives in this root, so it needs its own rules —
 * and inherits the theme's custom properties, light or dark, from the host). */
const PANE_CSS = `
:host { display: block; }
.pane { display: grid; grid-template-rows: 1fr; min-height: 100%; position: relative; }
/* The pierre mount point, and the one container a paint may wipe (a
   placeholder, a note, an open error). The hover tip is the pane's own child,
   beside it, so a wipe never takes the tip with it. A grid item stretched to
   its row has a definite height, which pierre's own percentage heights (the
   tree's virtualized list) resolve against. */
.pane-body { display: flex; flex-direction: column; min-width: 0; }
.pane-body > * { flex: 1; min-height: 100%; }
.intel-tip {
  position: absolute;
  z-index: 20;
  box-sizing: border-box;
  width: max-content;
  max-width: min(40rem, calc(100% - 1rem));
  height: auto;
  max-height: 16rem;
  overflow: auto;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-base-300, #444);
  border-radius: var(--radius-box, 0.5rem);
  background: var(--color-base-100, #1b1b1b);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  color: var(--color-base-content, #ddd);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.4;
  user-select: text;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.intel-tip[hidden] { display: none; }
/* The open file's change, in the code header beside its name: the same letter
   and kind the tree's lane paints (see editor.ts). */
.noite-src-change {
  align-items: center;
  background: var(--color-base-200, #2a2a2a);
  border-radius: 0.25rem;
  color: var(--color-base-content, #ddd);
  display: inline-flex;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  font-weight: 600;
  height: 1.05rem;
  justify-content: center;
  margin-left: 0.4rem;
  min-width: 1.05rem;
  padding: 0 0.25rem;
}
.noite-src-change[hidden] { display: none; }
.noite-src-change[data-change-kind="added"] { color: var(--color-success, #16a34a); }
.noite-src-change[data-change-kind="deleted"] { color: var(--color-error, #dc2626); }
.noite-src-change[data-change-kind="moved"] { color: var(--color-warning, #d97706); }
.intel-code span {
  color: light-dark(var(--diffs-token-light, inherit), var(--diffs-token-dark, inherit));
}
.intel-head { opacity: 0.7; margin-bottom: 0.25rem; }
.intel-docs {
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--color-base-300, #444);
  font-family: var(--font-sans, system-ui, sans-serif);
}
.intel-errors {
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--color-base-300, #444);
  color: var(--color-error, #f87171);
}
.intel-errors:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
/* daisyUI's \`skeleton\` (https://daisyui.com/components/skeleton/), copied:
   the page's stylesheet does not reach into this shadow root, but the theme's
   custom properties do, so the shimmer matches every other skeleton. One
   change: the gradient is fixed to the viewport, so every bar shows a slice
   of one sweep instead of each tiny icon drawing its own diagonal slash. */
.skeleton {
  border-radius: var(--radius-box, 0.5rem);
  background-color: var(--color-base-300, #333);
  background-image: linear-gradient(105deg, #0000 0% 40%, var(--color-base-100, #1b1b1b) 50%, #0000 60% 100%);
  background-position-x: -50%;
  background-size: 200%;
  background-attachment: fixed;
  will-change: background-position;
}
@media (prefers-reduced-motion: no-preference) {
  .skeleton { animation: 1.8s ease-in-out infinite skeleton; }
}
@keyframes skeleton {
  0% { background-position: 150%; }
  to { background-position: -50%; }
}
.skel { display: flex; flex-direction: column; gap: 0.7rem; overflow: hidden; padding: 0.75rem; }
.skel-row { align-items: center; display: flex; gap: 0.6rem; flex: none; }
.skel-bar { border-radius: 0.25rem; flex: none; height: 0.7rem; }
.skel-icon { border-radius: 0.25rem; flex: none; height: 0.9rem; width: 0.9rem; }
.skel-head { border-bottom: 1px solid var(--color-base-300, #333); margin: -0.75rem -0.75rem 0.2rem; padding: 0.75rem; }
.skel-gutter { width: 1.4rem; opacity: 0.6; }
.skel-label {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
`;

/** Bar widths (rem) and indents (levels) for the placeholder rows: fixed, so
 * every load draws the same shape instead of jittering. */
const TREE_ROWS: readonly (readonly [indent: number, width: number])[] = [
  [0, 5],
  [0, 4],
  [1, 6.5],
  [1, 5.5],
  [1, 7],
  [0, 6],
  [0, 8],
  [0, 5.5],
  [0, 7.5],
  [0, 4.5],
  [0, 6],
];

const CODE_ROWS: readonly (readonly [indent: number, width: number])[] = [
  [0, 22],
  [0, 18],
  [0, 0],
  [0, 14],
  [1, 16],
  [1, 11],
  [1, 20],
  [2, 13],
  [2, 17],
  [1, 6],
  [0, 4],
  [0, 0],
  [0, 19],
  [0, 24],
  [0, 0],
  [0, 15],
];

/** A row of the skeleton: a tree row (icon indented by depth, then a name) or
 * a code line (line-number gutter, then text indented by depth). A zero width
 * draws a blank line. */
const skeletonRow = (
  lead: "gutter" | "icon",
  indent: number,
  width: number
): HTMLElement => {
  const row = document.createElement("div");
  row.className = "skel-row";
  const head = document.createElement("div");

  if (lead === "icon") {
    head.className = "skeleton skel-icon";
    head.style.marginLeft = `${indent * 0.9}rem`;
  } else {
    head.className = "skeleton skel-bar skel-gutter";
    head.style.marginRight = `${indent * 1.2}rem`;
  }

  row.append(head);

  if (width > 0) {
    const bar = document.createElement("div");
    bar.className = "skeleton skel-bar";
    bar.style.width = `${width}rem`;
    row.append(bar);
  }

  return row;
};

/** Paint `body` (a `paneIn` body) as a daisyUI skeleton of a file tree or an
 * open file while the checkout opens. Screen readers get `label`; whatever
 * paints the body next replaces it. */
export const paintSkeleton = (
  body: HTMLElement,
  kind: "code" | "tree",
  label: string
): void => {
  const skel = document.createElement("div");
  skel.className = "skel";
  skel.setAttribute("role", "status");
  skel.setAttribute("aria-busy", "true");
  const text = document.createElement("span");
  text.className = "skel-label";
  text.textContent = label;
  skel.append(text);

  if (kind === "tree") {
    for (const [indent, width] of TREE_ROWS) {
      skel.append(skeletonRow("icon", indent, width));
    }
  } else {
    const head = skeletonRow("icon", 0, 9);
    head.classList.add("skel-head");
    skel.append(head);

    for (const [indent, width] of CODE_ROWS) {
      skel.append(skeletonRow("gutter", indent, width));
    }
  }

  body.replaceChildren(skel);
};

/** The mount point pierre renders into, inside a shadow root on `host`: the
 * pane's body. The pane itself holds everything a paint of that body must not
 * wipe — the hover tip first of all (see the CSS above), and the tree's drop
 * highlight and file picker. ilha re-renders this component often (every
 * onState report, every ?file= write), and its morph makes a host's light-DOM
 * children and attributes match the (empty) JSX — deleting pierre's editor
 * nodes and stripping its host styles. Shadow content is invisible to the
 * morph; theme custom properties set on the host still inherit into it. */
export const paneIn = (host: HTMLElement): HTMLElement => {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  let pane = root.querySelector<HTMLElement>(".pane");

  if (pane === null) {
    const style = document.createElement("style");
    style.textContent = PANE_CSS;
    pane = document.createElement("div");
    pane.className = "pane";
    root.append(style, pane);
  }

  const existing = pane.querySelector<HTMLElement>(".pane-body");

  if (existing !== null) {
    return existing;
  }

  const body = document.createElement("div");
  body.className = "pane-body";
  pane.append(body);

  return body;
};
