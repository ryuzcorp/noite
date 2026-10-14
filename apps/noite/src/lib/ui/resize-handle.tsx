/** The divider between two panes of a resizable group (`$lib/ui/resizable`): a
 * one-pixel line whose invisible hit area is wider than the line itself, hidden
 * below `lg` where the page's classes lay its panes out and nothing is bound.
 *
 * The library finds it by `data-slot`, drags it by pointer or arrow key, and
 * keeps its role, its aria and its `data-active` — all of which the morph has
 * to leave alone, so it wears `MORPH_PRESERVE` like the group and its panes. */
import { MORPH_PRESERVE } from "./resizable";

export const ResizeHandle = ({
  label,
  vertical = false,
}: {
  /** What the handle resizes, for whoever cannot see it ("Resize file tree"). */
  label: string;
  /** A divider between stacked panes (the terminal) rather than side by side. */
  vertical?: boolean;
}) => (
  <div
    data-slot="resizable-handle"
    data-morph-preserve={MORPH_PRESERVE}
    role="separator"
    aria-label={label}
    tabindex={0}
    class={`bg-base-300 data-active:bg-primary relative shrink-0 outline-none before:absolute before:content-[''] max-lg:hidden ${
      vertical
        ? "h-px w-full cursor-row-resize before:inset-x-0 before:-inset-y-1"
        : "w-px cursor-col-resize before:-inset-x-1 before:inset-y-0"
    }`}
  ></div>
);
