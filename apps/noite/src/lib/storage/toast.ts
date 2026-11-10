//! The storage views' toast queue: pure transitions plus the expiry rule, with
//! the atom and the timers owned by `useToasts` (./shared).
//!
//! Before this, each panel had an id counter in a lazy box and an uncancelled
//! 4 s timer per message; identical messages stacked, the queue was unbounded,
//! and nothing announced a toast to screen readers.
//!
//! ```text
//! [] ──push(text)──▶ [toast …] ──expire(id)──▶ [… without id]
//!                   └──push(same text as the last)──▶ unchanged (refreshed timer)
//! ```

/** One transient confirmation. */
export interface Toast {
  id: number;
  text: string;
}

/** Toasts on screen at once; the oldest is dropped past this. */
export const MAX_TOASTS = 4;

/** How long one toast lives. */
export const TOAST_MS = 4000;

/** The queue after one event; pure, so the rules are unit-testable. */
export const nextToasts = (
  queue: readonly Toast[],
  event:
    | { readonly id: number }
    | { readonly id: number; readonly text: string }
): Toast[] => {
  if ("text" in event) {
    // An identical message already on screen is not repeated; its timer is
    // refreshed by the caller.
    if (queue.some((toast) => toast.id === event.id)) {
      return [...queue];
    }

    const kept = queue.length >= MAX_TOASTS ? queue.slice(1) : queue;

    return [...kept, { id: event.id, text: event.text }];
  }

  return queue.filter((toast) => toast.id !== event.id);
};

/** Arm one toast's expiry; the caller owns the timer map and its cleanup. */
export const scheduleExpiry = (
  timers: Map<number, number>,
  id: number,
  queue: () => readonly Toast[],
  expire: (next: Toast[]) => void
): void => {
  window.clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      expire(nextToasts(queue(), { id }));
    }, TOAST_MS)
  );
};
