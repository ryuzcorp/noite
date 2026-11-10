/** The app's confirmation dialog: a native `<dialog>` in daisyUI's `modal`
 * dress (the look of `./dialog.tsx`), opened imperatively so any handler can
 * `await` an answer, the way it would `window.confirm`. The confirm button has
 * the focus, so Enter confirms.
 *
 * The answer is a reason, not a boolean: "the user said no" (`cancel`), "the
 * pane went away" (`abort`) and "the user said yes" (`confirm`) are three
 * different things, and a caller that tears down on abort must not treat it as
 * consent. Callers compare `=== "confirm"`. */

/** Why the dialog closed. */
export type ConfirmReason = "abort" | "cancel" | "confirm";

export interface ConfirmOptions {
  /** The confirm button's label ("Delete", "Roll back"). */
  confirmLabel: string;
  /** What happens if the user confirms; omit when the title says it all. */
  message?: string;
  /** Answers `abort` and closes the dialog when aborted (a torn-down pane). */
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
}: ConfirmOptions): Promise<ConfirmReason> => {
  const answered = Promise.withResolvers<ConfirmReason>();

  if (signal?.aborted) {
    answered.resolve("abort");

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

  let reason: ConfirmReason = "cancel";

  const onAbort = () => {
    reason = "abort";
    dialog.close();
  };

  dialog.addEventListener("close", () => {
    signal?.removeEventListener("abort", onAbort);
    dialog.remove();
    answered.resolve(reason);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  cancel.addEventListener("click", () => {
    dialog.close();
  });
  confirm.addEventListener("click", () => {
    reason = "confirm";
    dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  confirm.focus();

  return answered.promise;
};
