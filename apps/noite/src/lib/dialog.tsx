//! Shared native `<dialog>` wrapper (daisyUI `modal` styling).
//!
//! `<Dialog open={dialogOpen}>` calls `showModal()` / `close()` from
//! `watch(open, …)` through its `ref`, and `onclose` syncs the atom back
//! so Esc and backdrop clicks close too. Native `showModal()` traps focus
//! and returns it to the opener; no `modal-open` class juggling.
import { atom, watch } from "ilha";
import type { AtomHandle, View } from "ilha";

import { collectRef, liveEl, newLiveRef } from "./live-ref";

export const Dialog = ({
  children,
  class: cls,
  labelledBy,
  onClose,
  open,
}: {
  children: View;
  class?: string;
  /** id of the element naming this dialog (sets `aria-labelledby`). */
  labelledBy?: string;
  onClose?: () => void;
  open: AtomHandle<boolean>;
}) => {
  // The live <dialog>: ilha also hands `ref` detached scratch copies on
  // every re-render, so resolve the connected element at use (live-ref.ts).
  // atom.lazy keeps the holder across re-renders (a body `let` would not).
  const box = atom.lazy(newLiveRef<HTMLDialogElement>)();
  const sync = (want: boolean) => {
    const dlg = liveEl(box);
    if (!dlg) {
      return;
    }
    if (want && !dlg.open) {
      dlg.showModal();
    } else if (!want && dlg.open) {
      dlg.close();
    }
  };
  watch(open, (v) => {
    sync(v);
  });
  return (
    <dialog
      ref={(el) => {
        collectRef(box, el);
        // Already open at mount (e.g. a drawer that mounts visible): the
        // ref runs before insertion, so open on the next frame, once live.
        if (el && open()) {
          requestAnimationFrame(() => {
            sync(open());
          });
        }
      }}
      class={cls}
      aria-labelledby={labelledBy}
      onclose={() => {
        open.set(false);
        onClose?.();
      }}
    >
      {children}
    </dialog>
  );
};
