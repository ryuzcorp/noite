//! Splitting a page's panes: one binding per group, kept in step with ilha.
//!
//! `createResizable` (`@data-slot/resizable`) reads a group's panes, their
//! limits and its opening split from the DOM once, lays the group out with
//! flex styles of its own, and reports every split it lands on. This wraps it
//! with what the app needs around that:
//!
//! - `ref` binds the group to the element ilha's morph keeps live — once, and
//!   only once the element is really in the document, so the library can
//!   measure it. A re-render hands `ref` detached scratch copies as well (see
//!   live-ref.ts), and the panes themselves come and go (the terminal panel),
//!   so a binding is dropped and remade around the DOM the group has now;
//! - the split is kept in localStorage under a versioned key per group, and
//!   drawn back as each pane's `data-default-size` on the next bind, so a
//!   reload opens where the user left it. A value that is not one, finite,
//!   non-negative size per pane is ignored (another version's shape, another
//!   group's, a hand-edited one) and the group opens on the split the page's
//!   own classes already gave the panes;
//! - the panes' pixel minimums and maximums become the percentages the
//!   library takes. They are remeasured through a ResizeObserver as the group
//!   itself resizes, and the group is rebound around the split it is already
//!   on, so nothing jumps;
//! - a collapsible pane (the side panel) slides: the flex-grow transition is
//!   a class on `<html>` for its duration only, so a page repaint cannot take
//!   it off the group mid-slide and a drag never has it — drags stay 1:1 with
//!   the pointer. `prefers-reduced-motion` gets no slide at all;
//! - while a handle drags, `<html>` wears `noite-dragging`: every iframe goes
//!   `pointer-events: none` (a pod frame under the pointer would swallow
//!   every move, a preview frame every hover) and nothing selects;
//! - below `lg` nothing binds: there the page lays its panes out with classes,
//!   as it always did, and crossing the breakpoint is a bind/unbind rather
//!   than a different DOM.
//!
//! The attributes all of this lives on (`style`, the role and aria the library
//! sets, the collapse state, the measured limits) have to survive ilha's
//! morphs, which drop what a render does not name — so every group, pane and
//! handle renders `MORPH_PRESERVE` (see ilha's `syncAttributes`).

import { createResizable } from "@data-slot/resizable";
import type {
  ResizableController,
  ResizableDirection,
} from "@data-slot/resizable";

/** daisyUI's `lg`: the width the split layouts exist at. */
const LG_QUERY = "(min-width: 64rem)";

/** Nothing slides, and no slide class is added, when the user asked for less
 * motion. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** How long a slide runs — a mirror of the `noite-resizing` transition in
 * app.css — and how long past it the class is taken off when no transition
 * reports back (nothing moved, or the CSS asked for less motion). */
const SLIDE_MS = 200;
const SLIDE_SLACK_MS = 80;

/** `<html>` wears this while a slide runs (see the file header). */
const SLIDING = "noite-resizing";

/** `<html>` wears this while a handle drags (see the file header). */
const DRAGGING = "noite-dragging";

/** Where a group's split is kept. The version is in the key, so a future
 * shape cannot be mistaken for this one. */
const STORAGE_PREFIX = "noite:ui:resizable:v1:";

/** How far a pane's minimum may move before the group is rebound around it,
 * in percent. */
const MIN_STEP = 0.5;

/** How long a change waits before the split is written: long enough that a
 * drag's own stream of changes costs one write (the end of the drag writes
 * straight away). */
const SAVE_MS = 200;

/** The panes' minimums may not fill the group: past this share they are
 * scaled down together (the library refuses constraints that cannot form a
 * layout of 100%, and a group barely wider than its own minimums is not worth
 * a crash). */
const MIN_TOTAL = 90;

/** Everything `createResizable` writes onto a group, its panes and its
 * handles that a render does not name: the flex sizes, the collapse state,
 * the separator's role and aria, the limits this helper measures. ilha's
 * morph rewrites an element's attributes from the render and drops the ones
 * the render leaves out, so a repaint would take the whole layout with it —
 * render this on each of those elements to keep them. */
export const MORPH_PRESERVE =
  "style id role aria-controls aria-orientation aria-valuemin aria-valuemax aria-valuenow aria-valuetext data-state data-collapsed data-expanded data-active data-min-size data-max-size";

export interface PaneGroupOptions {
  /** Which split this group keeps: one localStorage key, so a group that is
   * the same on every page (the app sidebar) keeps one size app-wide. */
  key: string;
  direction: ResizableDirection;
  /** The smallest each pane may get, in px (0 = no minimum). */
  minPx: readonly number[];
  /** The largest each pane may get, in px (null = the whole group). */
  maxPx?: readonly (number | null)[];
  /** Where each pane opens, in px, until something is dragged — a pane left
   * null takes what the named ones leave. Without this, the panes open at the
   * sizes the page's own classes already give them. */
  openPx?: readonly (number | null)[];
  /** The panes that can close to nothing, one index each. */
  collapsible?: readonly number[];
  /** Which of them open closed — the page's own state at mount (`?panel=`). */
  closed?: readonly number[];
  /** Called when a pane the page wanted *open* closed anyway: a drag (or an
   * arrow key) past its minimum, which the library snaps to the collapsed
   * size. The page's own state (`?panel=` and the toggle it drives) can follow
   * it, so the URL, the toggle and the pane agree. */
  onCollapsed?: (index: number) => void;
}

export interface PaneGroup {
  /** The group root's `ref`. */
  ref: (el: HTMLElement | null) => void;
  /** The split this group last kept, for a group of `count` panes (each pane
   * carries it as `data-default-size`). */
  stored: (count: number) => number[] | null;
  /** Open or close a collapsible pane, sliding it when the user allows
   * motion. Safe to call on every render. */
  setOpen: (index: number, open: boolean) => void;
  /** Everything the helper holds — the binding, the observers, the classes on
   * `<html>`. The panes are left where the split put them. */
  destroy: () => void;
}

/** Whether a stored value is a split of `count` panes: one finite,
 * non-negative size each, adding up to something. Anything else (another
 * version's shape, another group's, a hand-edited value) is ignored. */
const isSplit = (value: unknown, count: number): value is number[] => {
  if (!Array.isArray(value) || value.length !== count) {
    return false;
  }

  let total = 0;

  for (const size of value) {
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      return false;
    }

    total += size;
  }

  return total > 0;
};

/** The split kept for `key`, or null (nothing stored, a store that refuses, or
 * a value that is not a split of `count` panes). */
const readStored = (key: string, count: number): number[] | null => {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);

    if (raw === null) {
      return null;
    }

    // SAFETY: JSON.parse returns any; nothing trusts it — `isSplit` narrows
    // the value field by field.
    const parsed: unknown = JSON.parse(raw);

    return isSplit(parsed, count) ? parsed : null;
  } catch {
    // Storage is off (private mode, a denied origin): the group opens on the
    // split its classes gave it, and keeps that until it is dragged.
    return null;
  }
};

/** Keep the split the user landed on. A store that refuses only costs the
 * preference. */
const writeStored = (key: string, layout: readonly number[]): void => {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(layout));
  } catch {
    // See `readStored`.
  }
};

/** A number for an attribute: three decimals is finer than a pane's own pixel
 * and short enough to read in the DOM. */
const draw = (value: number): string => String(Math.round(value * 1000) / 1000);

/** How long the group is on its own axis, in px. */
const axisSize = (el: Element, horizontal: boolean): number => {
  const box = el.getBoundingClientRect();

  return horizontal ? box.width : box.height;
};

/** The panes (or handles) the group owns: its descendants up to the next
 * group, which the library reads the same way. */
const owned = (root: HTMLElement, slot: string): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)].filter(
    (el) => el.parentElement?.closest('[data-slot="resizable"]') === root
  );

/** A pane's limits, as the percentages the library takes. */
interface PaneLimits {
  max: number[];
  min: number[];
}

/** A pane's limits for a group `size` px long: the page's pixel minimums and
 * maximums, with the minimums scaled down together when they cannot fit. */
const paneLimits = (
  options: PaneGroupOptions,
  panes: readonly HTMLElement[],
  size: number
): PaneLimits => {
  const share = (px: number): number =>
    Math.max(0, Math.min(100, (px / size) * 100));

  const min = options.minPx.slice(0, panes.length).map(share);

  const max = panes.map((_pane, index) => {
    const px = options.maxPx?.[index] ?? null;

    return px === null ? 100 : share(px);
  });

  const total = min.reduce((sum, value) => sum + value, 0);
  const scale = total > MIN_TOTAL ? MIN_TOTAL / total : 1;

  return {
    max,
    min: min.map((value, index) => Math.min(value * scale, max[index] ?? 100)),
  };
};

/** Whether a pane already carries this limit (within the rounding it is drawn
 * at). */
const limitHolds = (
  el: HTMLElement,
  key: "maxSize" | "minSize",
  want: number
): boolean => {
  const raw = el.dataset[key];
  const have = raw === undefined ? Number.NaN : Number(raw);

  return Number.isFinite(have) && Math.abs(have - want) <= MIN_STEP;
};

/** Whether the panes already carry these limits. */
const limitsHold = (
  panes: readonly HTMLElement[],
  limits: PaneLimits
): boolean =>
  panes.every(
    (pane, index) =>
      limitHolds(pane, "minSize", limits.min[index] ?? 0) &&
      limitHolds(pane, "maxSize", limits.max[index] ?? 100)
  );

/** The split the panes are on now, in percent of their own total — what the
 * page's classes gave them before the library took the layout over. */
const measuredSplit = (
  panes: readonly HTMLElement[],
  horizontal: boolean
): number[] | null => {
  const sizes = panes.map((pane) => axisSize(pane, horizontal));
  const total = sizes.reduce((sum, size) => sum + size, 0);

  return total > 0 ? sizes.map((size) => (size / total) * 100) : null;
};

/** The split the panes open at, in percent: the one the user left, or the one
 * the page asked for — `openPx` read against the group, or else the sizes the
 * page's classes already give the panes. A pane left null is the library's to
 * fill (it takes an even share of what the named ones leave). */
const openingSplit = (
  options: PaneGroupOptions,
  panes: readonly HTMLElement[],
  size: number,
  horizontal: boolean
): (number | null)[] | null => {
  const stored = readStored(options.key, panes.length);

  if (stored !== null) {
    return stored;
  }

  if (options.openPx === undefined || size <= 0) {
    return measuredSplit(panes, horizontal);
  }

  return panes.map((_pane, index) => {
    const px = options.openPx?.[index] ?? null;

    return px === null ? null : Math.max(0, Math.min(100, (px / size) * 100));
  });
};

/** Whether a `resizable:dragging` detail says a drag is in flight. */
const isDragging = (detail: unknown): detail is { dragging: true } =>
  typeof detail === "object" &&
  detail !== null &&
  "dragging" in detail &&
  detail.dragging === true;

export const createPaneGroup = (options: PaneGroupOptions): PaneGroup => {
  const collapsible = [...(options.collapsible ?? [])];
  const horizontal = options.direction === "horizontal";
  /** Whether each collapsible pane should be open: the page's own state
   * (`?panel=`), or the split a pane's own drag landed on. */
  const wanted = new Map<number, boolean>();

  for (const index of options.closed ?? []) {
    wanted.set(index, false);
  }

  /** The last split with every collapsible pane open: what reopening is owed,
   * and what is kept when a pane closes. */
  let open: number[] | null = null;
  let root: HTMLElement | null = null;
  let controller: ResizableController | null = null;
  let panels: HTMLElement[] = [];
  let observer: ResizeObserver | null = null;
  let mutations: MutationObserver | null = null;
  let media: MediaQueryList | null = null;
  let timer = 0;
  let saving = 0;
  let sliding: AbortController | null = null;
  /** Owns the listeners of the root the group is bound to now. */
  let binding: AbortController | null = null;
  let dragging = false;
  /** True while a bind is under way: the layout the library reports then is
   * the kept one, not something the user just changed. */
  let settling = false;
  const lifetime = new AbortController();

  const endSlide = (): void => {
    sliding?.abort();
    sliding = null;
    clearTimeout(timer);

    if (typeof document === "undefined") {
      // SSR: no binding ever ran, so there is no slide class to take off.
      return;
    }

    document.documentElement.classList.remove(SLIDING);
  };

  /** Take the binding down: the controller goes, and the flex styles it set
   * with it (its `destroy` leaves them behind), so the page's classes take the
   * layout back. The observers and the group's own split stay. */
  const unbind = (): void => {
    endSlide();
    dragging = false;

    if (typeof document !== "undefined") {
      document.documentElement.classList.remove(DRAGGING);
    }

    for (const el of [root, ...panels]) {
      el?.removeAttribute("style");
    }

    controller?.destroy();
    controller = null;
    panels = [];
  };

  const release = (): void => {
    unbind();
    binding?.abort();
    binding = null;
    observer?.disconnect();
    observer = null;
    mutations?.disconnect();
    mutations = null;
    root = null;
  };

  /** Apply the split the panes open at: the one the user left, or the page's
   * own opening sizes, so the library takes the layout over where it stands
   * instead of at an even split of its own. */
  const applyOpening = (panes: readonly HTMLElement[], size: number): void => {
    const split = openingSplit(options, panes, size, horizontal);

    for (const [index, pane] of panes.entries()) {
      const opening = split?.[index];

      if (opening === null || opening === undefined) {
        delete pane.dataset.defaultSize;
        continue;
      }

      pane.dataset.defaultSize = draw(opening);
    }
  };

  /** Write the split the group is on now, unless a newer one is already on its
   * way: a drag reports every move, and a synchronous store on each of them
   * would show up in the drag. */
  const remember = (): void => {
    clearTimeout(saving);
    saving = window.setTimeout(() => {
      if (open !== null) {
        writeStored(options.key, open);
      }
    }, SAVE_MS);
  };

  /** Write it now: a drag that ended, or the page going away. */
  const save = (): void => {
    clearTimeout(saving);
    saving = 0;

    if (open !== null) {
      writeStored(options.key, open);
    }
  };

  /** Keep what a change means: the split to reopen into (a pane that closed is
   * not a preference), where each collapsible pane now stands, and the split
   * the user landed on. */
  const changed = (layout: number[]): void => {
    if (settling) {
      return;
    }

    const closed = collapsible.filter((index) => layout[index] === 0);

    if (closed.length === 0) {
      open = [...layout];

      for (const index of collapsible) {
        wanted.set(index, true);
      }
    } else {
      for (const index of closed) {
        // A pane the page wanted open that closed anyway was closed by the
        // user's own drag (or arrow key) past its minimum — the page hears
        // about it so its state can agree (see `onCollapsed`). Its own request
        // to close has already set `wanted` false, so it does not hear itself.
        if (wanted.get(index) ?? true) {
          options.onCollapsed?.(index);
        }

        wanted.set(index, false);
      }
    }

    remember();
  };

  /** Close or open one pane, sliding the group when the user allows motion.
   * The slide ends on the transition it starts — or on the timer behind it,
   * when no transition reports (nothing moved, or the CSS asked for less
   * motion). */
  const apply = (index: number, shouldOpen: boolean, slide: boolean): void => {
    const current = controller;

    if (current === null || current.isCollapsed(index) === !shouldOpen) {
      return;
    }

    if (slide && !window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      endSlide();
      document.documentElement.classList.add(SLIDING);

      const finish = (): void => {
        endSlide();
      };

      sliding = new AbortController();
      root?.addEventListener(
        "transitionend",
        (event) => {
          if (event.propertyName === "flex-grow") {
            finish();
          }
        },
        { signal: sliding.signal }
      );
      timer = window.setTimeout(finish, SLIDE_MS + SLIDE_SLACK_MS);
    }

    if (shouldOpen) {
      current.expand(index);
    } else {
      current.collapse(index);
    }
  };

  /** Put every collapsible pane where the page (and the last drag) says it
   * should be — including the size a pane that opens closed has to remember,
   * since the note the library keeps dies with its controller. */
  const applyWanted = (layout: readonly number[] | null): void => {
    const current = controller;

    if (current === null) {
      return;
    }

    for (const index of collapsible) {
      const shouldOpen = wanted.get(index) ?? true;

      if (!shouldOpen && current.isCollapsed(index) && layout !== null) {
        current.setLayout([...layout]);
      }

      apply(index, shouldOpen, false);
    }
  };

  /** Bind the group to the DOM it has now — over the split it is on, when the
   * panes are the ones it was bound to (a resize moved the limits, or the
   * group was unbound below `lg` and is back). */
  const rebind = (el: HTMLElement, panes: HTMLElement[]): void => {
    const previous = controller?.layout ?? null;

    const keep =
      previous !== null && previous.length === panes.length
        ? [...previous]
        : null;

    unbind();
    settling = true;
    const size = axisSize(el, horizontal);
    const limits = paneLimits(options, panes, size);

    for (const [index, pane] of panes.entries()) {
      pane.dataset.minSize = draw(limits.min[index] ?? 0);
      pane.dataset.maxSize = draw(limits.max[index] ?? 100);
    }

    applyOpening(panes, size);
    controller = createResizable(el, {
      direction: options.direction,
      onLayoutChange: changed,
    });
    panels = panes;

    if (keep !== null) {
      controller.setLayout(keep);
    }

    applyWanted(keep ?? readStored(options.key, panes.length));
    settling = false;
  };

  /** Bring the binding in step with the group's DOM and the size it is at. */
  const sync = (): void => {
    const el = root;

    if (el === null || media === null || !media.matches) {
      unbind();

      return;
    }

    const panes = owned(el, "resizable-panel");
    const handles = owned(el, "resizable-handle");
    const size = axisSize(el, horizontal);

    if (
      panes.length === 0 ||
      handles.length !== panes.length - 1 ||
      size <= 0
    ) {
      // Not a group yet (a mount in progress), or nothing to lay out: keep
      // watching, bind nothing.
      unbind();

      return;
    }

    const same =
      panes.length === panels.length &&
      panes.every((pane, index) => pane === panels[index]);

    if (
      same &&
      controller !== null &&
      limitsHold(panes, paneLimits(options, panes, size))
    ) {
      return;
    }

    rebind(el, panes);
  };

  /** The library reports a drag on the group root (the event bubbles): while
   * one runs, no frame may swallow a move and nothing selects — see app.css. */
  const onDragging = (event: Event): void => {
    // SAFETY: the library's own event carries `{ dragging: boolean }`; the
    // value is read as unknown and narrowed by `isDragging`.
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    const now = isDragging(detail);

    if (now === dragging) {
      return;
    }

    dragging = now;
    document.documentElement.classList.toggle(DRAGGING, now);

    if (!now) {
      // The drag is over: what it landed on is what to keep, now.
      save();
    }
  };

  const attach = (el: HTMLElement): void => {
    release();
    root = el;
    binding = new AbortController();

    if (media === null) {
      // The breakpoint is the helper's, not the element's: it decides whether
      // a group binds at all.
      media = window.matchMedia(LG_QUERY);
      media.addEventListener("change", sync, { signal: lifetime.signal });
    }

    el.addEventListener("resizable:dragging", onDragging, {
      signal: binding.signal,
    });
    observer = new ResizeObserver(sync);
    observer.observe(el);
    mutations = new MutationObserver(sync);
    mutations.observe(el, { childList: true, subtree: true });
    sync();
  };

  const ref = (el: HTMLElement | null): void => {
    if (el === null || el === root) {
      return;
    }

    if (el.isConnected) {
      attach(el);

      return;
    }

    // A re-render's scratch copy (see live-ref.ts), or a first mount that
    // called `ref` before insertion: bind the element that really lands in the
    // document, once it is there.
    void (async () => {
      for (let frame = 0; frame < 120 && !el.isConnected; frame += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop, promise/avoid-new -- one frame per pass; the loop ends at the first inserted element
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }

      if (el.isConnected && el !== root) {
        attach(el);
      }
    })();
  };

  const setOpen = (index: number, shouldOpen: boolean): void => {
    if (!collapsible.includes(index)) {
      return;
    }

    wanted.set(index, shouldOpen);
    // Idempotent: a pane already where the page wants it is left alone (which
    // is also what keeps a repaint from re-opening a pane it closed by drag).
    apply(index, shouldOpen, true);
  };

  return {
    destroy: () => {
      // Whatever the last drag landed on is kept, even if the page is going
      // away mid-way through the wait behind it.
      save();
      release();
      lifetime.abort();
    },
    ref,
    setOpen,
    stored: (count) => readStored(options.key, count),
  };
};
