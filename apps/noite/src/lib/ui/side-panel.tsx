/** The right-hand panel shared by Code mode and the app detail page: a title
 * row (title, extras, actions, close) above a scrolling body. On wide screens
 * it is the `1fr` column of a `2fr 1fr` grid (`SPLIT_GRID`); below `lg` there
 * is no room for two columns, so it covers the page instead (the grid must be
 * `relative`). */
import type { View } from "ilha";

import { X } from "./icons";

/** Grid columns for a page with its panel open or closed. */
export const splitColumns = (open: boolean): string =>
  open ? "grid-cols-1 lg:grid-cols-[2fr_1fr]" : "grid-cols-1";

export const SidePanel = ({
  actions,
  children,
  extras,
  onClose,
  title,
}: {
  /** Buttons before the close button. */
  actions?: View;
  /** The body; it owns its padding and scrolling. */
  children: View;
  /** Next to the title (a count, a filter). */
  extras?: View;
  onClose: () => void;
  title: string;
}) => (
  <aside
    class="border-base-300 bg-base-200 dark:bg-base-100 flex min-h-0 min-w-0 flex-col max-lg:absolute max-lg:inset-0 max-lg:z-30 lg:border-l"
    aria-label={title}
  >
    <div class="border-base-300 flex items-center gap-2 border-b px-3 py-2">
      <h2 class="m-0 text-sm font-semibold">{title}</h2>
      {extras}
      <div class="ml-auto flex items-center gap-1">
        {actions}
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-square"
          aria-label="Close panel"
          onclick={onClose}
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
    {children}
  </aside>
);
