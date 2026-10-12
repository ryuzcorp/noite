/** The app's confirmation dialog: a native `<dialog>` in daisyUI's `modal`
 * dress (the look of `./dialog.tsx`), opened imperatively so any handler can
 * `await` an answer, the way it would `window.confirm`. Esc, the backdrop and
 * Cancel answer false; the confirm button answers true and has the focus, so
 * Enter confirms. */

export interface ConfirmOptions {
  /** The confirm button's label ("Delete", "Roll back"). */
  confirmLabel: string;
  /** What happens if the user confirms; omit when the title says it all. */
  message?: string;
  /** Answers false and closes the dialog when aborted (a torn-down pane). */
  signal?: AbortSignal;
  /** The question ("Delete util.ts?"). */
  title: string;
  /** `danger` (default) paints the confirm button as destructive. */
  tone?: "danger" | "neutral";
}

const button = (label: string, className: string): HTMLButtonElement => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
};

export const confirmDialog = ({
  confirmLabel,
  message,
  signal,
  title,
  tone = "danger",
}: ConfirmOptions): Promise<boolean> => {
  const answered = Promise.withResolvers<boolean>();
  if (signal?.aborted) {
    answered.resolve(false);
    return answered.promise;
  }
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.setAttribute("role", "alertdialog");
  const box = document.createElement("div");
  box.className = "modal-box bg-base-100 dark:bg-base-200";
  const heading = document.createElement("h3");
  heading.className = "m-0 text-lg font-bold";
  heading.id = `confirm-${crypto.randomUUID()}`;
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", heading.id);
  box.append(heading);
  if (message !== undefined) {
    const text = document.createElement("p");
    text.className = "m-0 py-2 text-sm opacity-80";
    text.textContent = message;
    box.append(text);
  }
  const cancel = button("Cancel", "btn btn-sm btn-ghost");
  const confirm = button(
    confirmLabel,
    `btn btn-sm ${tone === "danger" ? "btn-error" : "btn-neutral"}`
  );
  const actions = document.createElement("div");
  actions.className = "modal-action";
  actions.append(cancel, confirm);
  box.append(actions);
  const backdrop = document.createElement("form");
  backdrop.className = "modal-backdrop";
  backdrop.method = "dialog";
  const dismiss = document.createElement("button");
  dismiss.setAttribute("aria-label", "Close dialog");
  dismiss.textContent = "close";
  backdrop.append(dismiss);
  dialog.append(box, backdrop);

  let confirmed = false;
  const onAbort = () => {
    dialog.close();
  };
  dialog.addEventListener("close", () => {
    signal?.removeEventListener("abort", onAbort);
    dialog.remove();
    answered.resolve(confirmed);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  cancel.addEventListener("click", () => {
    dialog.close();
  });
  confirm.addEventListener("click", () => {
    confirmed = true;
    dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  confirm.focus();
  return answered.promise;
};
