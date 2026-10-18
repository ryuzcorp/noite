//! `searchParam` that re-renders the reader when the URL changes.
//!
//! TRANSIENT (slice 2, Oxide→Void): this used to read and write through
//! `@ilha/router`'s in-place navigation. It now reads the live document
//! location and writes with `history.replaceState`, with the same
//! navigation-cell subscription so a component below a keyed boundary still
//! repaints after an in-place write (`.set()`, tab clicks, paging). The
//! pages slice replaces this with Void's search handling.

import { atom } from "ilha";
import type { AtomHandle } from "ilha";

import { afterNavigate, notifyNavigated } from "./navigation";

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

/** Read and write one query param in the live document location. Unlike a
 * plain read, reading subscribes the reading component to navigations. */
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
    notifyNavigated();
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
