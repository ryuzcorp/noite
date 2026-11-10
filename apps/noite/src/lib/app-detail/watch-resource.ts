//! `watch` for a resource reader. ilha constrains a watch source to its
//! JSON-shaped `WatchValue`, while a `ResourceState` carries the fetch error
//! (unknown, not serialisable); the source is cast and the callback narrows
//! it straight back, so the subscription is the same one the resource atom
//! already drives.
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- ilha's `watch` accepts only a JSON-shaped WatchValue source; ResourceState's error is unknown by construction and the callback restores the exact type */
import { watch } from "ilha";
import type { AtomHandle } from "ilha";

import type { ResourceState } from "../resource";

export const watchResource = <T>(
  source: AtomHandle<ResourceState<T>>,
  onChange: (value: ResourceState<T>) => void
): void => {
  watch(source as unknown as AtomHandle<string>, (value) => {
    onChange(value as unknown as ResourceState<T>);
  });
};
