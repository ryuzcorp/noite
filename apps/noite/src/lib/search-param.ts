//! `searchParam` that re-renders the reader when the URL changes.
//!
//! Query-string state for tab switches, paging cursors, panel toggles and
//! other deep-linkable UI. Reads subscribe the rendering component to the
//! layout-provided cell; writes go through `history.replaceState` — no
//! navigation, no remount, no refetch — and bump the cell so a component
//! below a keyed boundary still repaints after an in-place write (`.set()`,
//! tab clicks, paging). Void's router has no query-state hook, so this is
//! the app's own state module, not a wrapper around one.

import { atom } from "ilha";
import type { AtomHandle } from "ilha";

/** One query param: call to read, `set`/`update` to write in place. */
export interface SearchParam<T> {
  (): T;
  set: (next: T) => void;
  update: (f: (current: T) => T) => void;
}

export interface SearchParamOptions<T> {
  /** Value when the param is absent. Writing it removes the param. */
  default: T;
  /** Decode the raw param. Default: the raw string. */
  parse?: (raw: string) => T;
  /** Encode a value for the URL. Default: `String(value)`. */
  serialize?: (value: T) => string;
}

export interface SearchParamFn {
  /** String param: `parse` is optional. */
  (name: string, opts: SearchParamOptions<string>): SearchParam<string>;
  /** Non-string param: `parse` is required to decode the raw string. */
  <T>(
    name: string,
    opts: SearchParamOptions<T> & { parse: (raw: string) => T }
  ): SearchParam<T>;
}

/** Parse a paging cursor (`?skip=`): a positive integer, anything else
 * (missing, `0`, negative, fractional, not a number) is the first page. */
export const parseSkip = (raw: string): number => {
  const value = Math.trunc(Number(raw));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

/** Version bumped after every in-place write; every param read subscribes. */
let cell: AtomHandle<number> | undefined;

/** Mount the shared query cell.
 *
 * The root layout calls this on every render, ahead of any early return:
 * `atom` allocates one slot per fiber, so the call has to stay unconditional
 * and in a fixed position. The layout renders above every page, so the cell
 * exists before the first param read; a route change that remounts the layout
 * (a different page component) replaces it. */
export const provideQueryCell = (): void => {
  cell = atom(0);
};

/** An in-place write landed: repaint every query-param reader. */
export const notifyQueryChanged = (): void => {
  cell?.update((version) => version + 1);
};

/** Read and write one query param in the live document location. Unlike a
 * plain read, reading subscribes the reading component to in-place writes. */
export const searchParam: SearchParamFn = <T>(
  name: string,
  opts: SearchParamOptions<T>
): SearchParam<T> => {
  // SAFETY: the default parser is the identity; T is inferred from opts.default, so callers without parse get T = string and raw already is one.
  const parse = opts.parse ?? ((raw: string): T => raw as T);
  const serialize = opts.serialize ?? String;
  const read = (): T => {
    if (typeof window === "undefined") {
      return opts.default;
    }
    const raw = new URLSearchParams(window.location.search).get(name);
    return raw === null ? opts.default : parse(raw);
  };
  const write = (next: T): void => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (next === opts.default) {
      params.delete(name);
    } else {
      params.set(name, serialize(next));
    }
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname +
        (query ? `?${query}` : "") +
        window.location.hash
    );
    notifyQueryChanged();
  };
  const param: SearchParam<T> = Object.assign(
    (): T => {
      // The value is not used: reading the cell is what registers the
      // subscription on the component that is rendering right now.
      cell?.();
      return read();
    },
    {
      set: write,
      update: (f: (current: T) => T): void => {
        write(f(read()));
      },
    }
  );
  return param;
};
