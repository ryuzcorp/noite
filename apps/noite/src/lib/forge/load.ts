//! What a forge resource view is showing: loading, a value, or a failure —
//! one closed union, so history, commit and compare cannot each invent their
//! own `data === undefined && error === undefined` test.
//!
//! There is deliberately no "refreshing with a stale snapshot" state: a reload
//! blanks `tracked`'s `data` while it runs (see `../resource`), so a stale
//! value and a load never coexist.

import { errorMessage } from "../errors";

/** One resource view's state. */
export type Load<T> =
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: T };

/** Derive the state from a `tracked` reader's cells. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- resource().error() is unknown by contract; errorMessage narrows it.
export const loadState = <T>(data: T | undefined, error: unknown): Load<T> => {
  if (data !== undefined) {
    return { _tag: "Ready", value: data };
  }

  if (error !== undefined && error !== null) {
    return { _tag: "Failed", message: errorMessage(error) };
  }

  return { _tag: "Loading" };
};

/** The value, or undefined — for the parts of a view that fold `Load` into
 * their own layout. */
export const loadValue = <T>(load: Load<T>): T | undefined =>
  load._tag === "Ready" ? load.value : undefined;
