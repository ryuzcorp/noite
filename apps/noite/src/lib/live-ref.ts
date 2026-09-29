//! Element refs that survive ilha re-renders.
//!
//! On a re-render ilha materializes the new JSX into a detached scratch tree
//! and calls `ref` with *those* elements too, then morphs the live DOM and
//! throws the scratch copies away. The last element a `ref` received is
//! therefore often detached (e2e: `showModal` → "The element is not in a
//! Document"). A LiveRef keeps the candidates and answers with the one that
//! is actually in the document, at the moment it is used.

/** Mutable per-instance holder; keep it in `atom.lazy(newLiveRef)()`. */
export interface LiveRef<T extends Element> {
  els: T[];
}

export const newLiveRef = <T extends Element>(): LiveRef<T> => ({ els: [] });

/** `ref` callback body: remember `el` (nulls are ignored — ilha also calls
 * them for scratch copies). Keeps the list short: connected elements plus
 * the newest one, which may not be inserted yet. */
export const collectRef = <T extends Element>(
  box: LiveRef<T>,
  el: T | null
): void => {
  if (!el) {
    return;
  }
  box.els = box.els.filter((e) => e !== el && e.isConnected);
  box.els.push(el);
};

/** The element currently in the document, or null. */
export const liveEl = <T extends Element>(box: LiveRef<T>): T | null => {
  for (let i = box.els.length - 1; i >= 0; i -= 1) {
    const el = box.els[i];
    if (el?.isConnected) {
      return el;
    }
  }
  return null;
};

/** Resolve the live element once it is inserted (a first mount calls `ref`
 * before insertion). Polls animation frames, bounded. */
export const whenLive = async <T extends Element>(
  box: LiveRef<T>,
  signal: AbortSignal,
  maxFrames = 120
): Promise<T | null> => {
  for (let i = 0; i < maxFrames && !signal.aborted; i += 1) {
    const el = liveEl(box);
    if (el) {
      return el;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, promise/avoid-new -- frame-paced wait for insertion; each check must see the previous frame
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }
  return liveEl(box);
};
