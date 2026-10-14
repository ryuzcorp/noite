/** The right-hand panel shared by Code mode and the app detail page: a title
 * row (title, extras, actions, close) above a scrolling body — or, `bare`, the
 * body alone, for a body that draws its own bar (Code mode's Preview). On wide
 * screens it fills the pane a page's own split gives it (Code mode's groups; the
 * app detail page's `2fr 1fr` grid, `splitColumns`); below `lg` there is no room
 * for two columns, so it covers the page instead (the page's own box must be
 * `relative`). */
import type { View } from "ilha";

import { X } from "./icons";

/** Grid columns for a page with its panel open or closed. */
export const splitColumns = (open: boolean): string =>
  open ? "grid-cols-1 lg:grid-cols-[2fr_1fr]" : "grid-cols-1";

/** The panel's close button: the title row's, and a bare body's own bar's. */
export const PanelClose = ({ onClose }: { onClose: () => void }) => (
  <button
    type="button"
    class="btn btn-ghost btn-xs btn-square opacity-70 hover:opacity-100"
    aria-label="Close panel"
    title="Close panel"
    onclick={onClose}
  >
    <X class="h-3.5 w-3.5" />
  </button>
);

export const SidePanel = ({
  actions,
  bare = false,
  children,
  classes,
  extras,
  onClose,
  slide = false,
  title,
}: {
  /** Buttons before the close button. */
  actions?: View;
  /** No title row: the body draws its own bar, close button included. */
  bare?: boolean;
  /** The body; it owns its padding and scrolling. */
  children: View;
  /** Extra classes on the panel itself (a page's own placement). */
  classes?: string;
  /** Next to the title (a count, a filter). */
  extras?: View;
  onClose: () => void;
  /** Wrap the body so a pane closing under it slides it out (`noite-panel-slide`
   * in app.css): Code mode's panel, which the page's own split collapses. */
  slide?: boolean;
  title: string;
}) => (
  <aside
    class={`border-base-300 bg-base-200 dark:bg-base-100 flex min-h-0 min-w-0 flex-col max-lg:absolute max-lg:inset-0 max-lg:z-30 lg:border-l ${classes ?? ""}`}
    aria-label={title}
  >
    {bare ? null : (
      <div class="border-base-300 flex min-h-9 items-center gap-2 border-b py-1 pr-1.5 pl-3">
        <h2 class="m-0 text-sm font-semibold">{title}</h2>
        {extras}
        <div class="ml-auto flex items-center gap-1">
          {actions}
          <PanelClose onClose={onClose} />
        </div>
      </div>
    )}
    {slide ? (
      <div class="noite-panel-slide flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
    ) : (
      children
    )}
  </aside>
);
