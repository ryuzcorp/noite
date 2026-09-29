//! Shared native `<dialog>` wrapper (daisyUI `modal` styling).
//!
//! `<Dialog open={dialogOpen}>` calls `showModal()` / `close()` from
//! `watch(open, …)` through its `ref`, and `onclose` syncs the atom back
//! so Esc and backdrop clicks close too. Native `showModal()` traps focus
//! and returns it to the opener; no `modal-open` class juggling.
import { atom, watch } from "ilha";
import type { AtomHandle, View } from "ilha";

interface DialogBox {
  el: HTMLDialogElement | null;
}

const newDialogBox = (): DialogBox => ({ el: null });

export const Dialog = ({
  children,
  class: cls,
  onClose,
  open,
}: {
  children: View;
  class?: string;
  onClose?: () => void;
  open: AtomHandle<boolean>;
}) => {
  // The element handle must survive re-renders: `watch` always runs the
  // latest render's callback, and `ref` fires only on mount — so a plain
  // `let` here is null after the first parent re-render and the dialog
  // never opens. atom.lazy returns the same box on every render.
  const box = atom.lazy(newDialogBox)();
  watch(open, (v) => {
    const dlg = box.el;
    if (!dlg) {
      return;
    }
    if (v && !dlg.open) {
      dlg.showModal();
    } else if (!v && dlg.open) {
      dlg.close();
    }
  });
  return (
    <dialog
      ref={(el) => {
        box.el = el;
        // Already open at mount (e.g. a drawer that mounts visible):
        // watch() ran during render, before the ref attached.
        if (el && open() && !el.open) {
          el.showModal();
        }
      }}
      class={cls}
      onclose={() => {
        open.set(false);
        onClose?.();
      }}
    >
      {children}
    </dialog>
  );
};
