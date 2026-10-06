//! The one copy-to-clipboard button: writes the value, confirms in place for
//! a moment. Every copy affordance (invite codes, git remote, object URLs,
//! D1 cells and CREATE statements) renders this — labelled or icon-only —
//! so there is a single confirmation timeout and one clipboard guard.

import { atom } from "ilha";

import { Check, Copy } from "./icons";

const COPIED_MS = 1500;

export const CopyButton = ({
  class: extra,
  iconClass,
  iconOnly = false,
  label,
  value,
}: {
  class?: string;
  iconClass?: string;
  /** Render the button as its icon only (aria-label still names the action). */
  iconOnly?: boolean;
  label: string;
  value: string;
}) => {
  const copied = atom(false);
  const size = iconClass ?? (iconOnly ? "h-4 w-4" : "h-3.5 w-3.5");
  const variant = iconOnly
    ? "btn btn-square btn-ghost btn-sm"
    : "btn btn-sm btn-ghost gap-1";
  return (
    <button
      type="button"
      class={extra ?? variant}
      aria-label={label}
      onclick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(value);
        copied.set(true);
        window.setTimeout(() => {
          copied.set(false);
        }, COPIED_MS);
      }}
    >
      {copied() ? <Check class={size} /> : <Copy class={size} />}
      {iconOnly ? null : <span>{copied() ? "Copied" : "Copy"}</span>}
    </button>
  );
};
