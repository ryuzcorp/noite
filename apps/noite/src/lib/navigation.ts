/**
 * TRANSIENT (slice 2, Oxide→Void build/entry cutover): client-side
 * navigation primitives replacing `@ilha/router`'s, with full-page
 * semantics. The Void pages slice replaces every import here with the Void
 * Router (`useRouter().visit`, `<Link>`, layout `children`, page `props`)
 * and deletes this module.
 *
 * Why full-page: `@ilha/router` re-rendered the route in place through its
 * mounted router. No router is mounted in this slice (Void generates the
 * client entry from `pages/` + `routes/`, which land later), so in-place
 * navigation has nothing to drive it. Every `navigate()` is a real document
 * load; `useRoute()` reads the live `location`; `head()` sets
 * `document.title`. Components keep compiling and keep working across the
 * reload — they just lose SPA transitions until the pages slice lands.
 */
import type { View } from "ilha";

export interface NavigateOptions {
  replace?: boolean;
  scroll?: boolean;
}

type NavigateHook = () => void;

const hooks = new Set<NavigateHook>();

/** Run every `afterNavigate` hook (also run before a full-page `navigate`). */
export const notifyNavigated = (): void => {
  for (const hook of hooks) {
    hook();
  }
};

/** Leave for `to`: a real document load (replace when `opts.replace`). */
export const navigate = (to: string, opts?: NavigateOptions): void => {
  notifyNavigated();
  if (typeof window === "undefined") {
    return;
  }
  if (opts?.replace) {
    window.location.replace(to);
    return;
  }
  window.location.assign(to);
};

/** Register `fn` after every navigation; returns the unsubscribe. */
export const afterNavigate = (fn: NavigateHook): (() => void) => {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
};

const noLocation = typeof window === "undefined";

/** The current route, read off the live document location. */
export interface RouteState {
  hash: () => string;
  navigating: () => boolean;
  params: () => Record<string, string>;
  path: () => string;
  search: () => string;
}
export const useRoute = (): RouteState => ({
  hash: () => (noLocation ? "" : window.location.hash),
  navigating: () => false,
  // Route params need the route pattern, which only Void's router knows —
  // the pages slice fills these in from `useParams()`.
  params: () => ({}),
  path: () => (noLocation ? "/" : window.location.pathname),
  search: () => (noLocation ? "" : window.location.search),
});

/** Contribute `<head>` data: the title reaches the document; the rest waits
 * for Void head management (pages slice). */
export const head = (input: { title?: string }): void => {
  if (input.title !== undefined && !noLocation) {
    document.title = input.title;
  }
};

/** A layout wraps `children` — the identity until Void layouts land. */

export const defineLayout = (
  layout: (props: { children: View }) => View
): ((props: { children: View }) => View) => layout;
