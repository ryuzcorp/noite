//! What a forge resource view is showing, derived from the reader's one
//! `ResourceState` — never from separate `data`/`error` cells. `Load` is a
//! presentation projection of that state (the error becomes display text and
//! `Reloading` keeps painting the value); it holds no state of its own.

import { errorMessage } from "../errors";
import type { ResourceState } from "../resource";

/** One resource view's state, projected from `ResourceState`. */
export type Load<T> =
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: T };

/** Project a reader's state for a view: only a cold key is `Loading`, a
 * failure is text, and both `Ready` and `Reloading` paint their value. */
export const loadState = <T>(state: ResourceState<T>): Load<T> => {
  switch (state._tag) {
    case "Failed": {
      return { _tag: "Failed", message: errorMessage(state.error) };
    }

    case "Loading": {
      return { _tag: "Loading" };
    }

    case "Ready":
    case "Reloading": {
      return { _tag: "Ready", value: state.value };
    }

    default: {
      return { _tag: "Loading" };
    }
  }
};

/** The value, or undefined — for the parts of a view that fold `Load` into
 * their own layout. */
export const loadValue = <T>(load: Load<T>): T | undefined =>
  load._tag === "Ready" ? load.value : undefined;
