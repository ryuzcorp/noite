//! `searchParam` that re-renders the reader when the URL changes.
//!
//! `@ilha/router` keeps the query string in a module variable and re-renders
//! the route in place, and ilha reuses a keyed component without re-running it
//! when its props are shallow-equal — so a plain `searchParam` read is not a
//! reactive read. A component that reads a param below such a keyed boundary,
//! or that receives a `SearchParam` handle as a prop, kept painting the old
//! query after an in-place navigation (`.set()`, tab clicks, paging).
//!
//! Every read here also reads one shared navigation cell, bumped after each
//! navigation: that read is what subscribes the reading component, whether the
//! handle was created there or handed down as a prop. The cell is installed by
//! the root layout instead of being created on first read because `atom`
//! claims a slot in the calling fiber's render — creating it lazily would
//! shift the slots of every later atom in whichever component read a param
//! first. Reads and writes still go through the router.

import { afterNavigate, searchParam as routeParam } from "@ilha/router";
import type {
  SearchParam,
  SearchParamFn,
  SearchParamOptions,
} from "@ilha/router";
import { atom } from "ilha";
import type { AtomHandle } from "ilha";

export type { SearchParam, SearchParamOptions } from "@ilha/router";

/** Version bumped after every navigation; every param read subscribes to it. */
let cell: AtomHandle<number> | undefined;

afterNavigate(() => {
  cell?.update((version) => version + 1);
});

/** Mount the shared navigation cell.
 *
 * The root layout calls this on every render, ahead of any early return:
 * `atom` allocates one slot per fiber, so the call has to stay unconditional
 * and in a fixed position. The layout renders above every page, so the cell
 * exists before the first param read; a route change that remounts the layout
 * (a different page component) replaces it. */
export const provideNavigationCell = (): void => {
  cell = atom(0);
};

/** The router's factory at its unconstrained overload.
 *
 * Its two overloads differ only in whether `parse` is required, and this one
 * takes `SearchParamOptions<T>`, which already leaves it optional. */
const makeParam = <T>(
  name: string,
  opts: SearchParamOptions<T>
): SearchParam<T> => {
  // SAFETY: the implementation applies `parse` when it is there and returns
  // the raw string otherwise — exactly what `SearchParamOptions<T>` describes.
  const routeCall = routeParam as (
    name: string,
    opts: SearchParamOptions<T>
  ) => SearchParam<T>;
  return routeCall(name, opts);
};

/** Read and write one query param through the router. Unlike the router's own
 * `searchParam`, reading it subscribes the reading component to navigations. */
export const searchParam: SearchParamFn = <T>(
  name: string,
  opts: SearchParamOptions<T>
): SearchParam<T> => {
  const param = makeParam(name, opts);
  return Object.assign(
    (): T => {
      // The value is not used: reading the cell is what registers the
      // subscription on the component that is rendering right now.
      cell?.();
      return param();
    },
    { set: param.set, update: param.update }
  );
};
