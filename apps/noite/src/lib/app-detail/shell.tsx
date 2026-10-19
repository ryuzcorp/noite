/** The detail layout shared by app pages, the Noite admin page and
 * `/account`: a header (identity, actions, tabs) that stays put above a
 * scrolling tab body, and an optional side panel, like Code mode. */
import type { View } from "ilha";

import { splitColumns } from "../ui/side-panel";

export const DetailShell = ({
  children,
  header,
  panel,
}: {
  children: View;
  header: View;
  /** The open side panel, or null. */
  panel: View | null;
}) => (
  <div
    class={`relative grid h-[calc(100dvh-3rem)] w-full overflow-hidden lg:h-dvh ${splitColumns(panel !== null)}`}
  >
    <div class="flex min-h-0 min-w-0 flex-col">
      <div class="flex shrink-0 flex-col gap-3 px-4 pt-4">{header}</div>
      <div class="min-h-0 flex-1 overflow-auto">
        <div class="flex flex-col gap-4 px-4 pt-4 pb-12">{children}</div>
      </div>
    </div>
    {panel}
  </div>
);

/** One row of tabs on every width: narrow screens scroll it sideways instead
 * of wrapping it into a stack. `trailing` sits at the row's end. The tabs are
 * a real tablist: roving tabindex and Left/Right/Home/End. Pass `idPrefix` to
 * also emit `id`/`aria-controls` for `<idPrefix>-panel-<id>` (render the panel
 * with that id and `role="tabpanel"`). */
export const DetailTabs = ({
  active,
  counts,
  idPrefix,
  onSelect,
  showZeroCounts = false,
  tabs,
  trailing,
}: {
  active: string;
  /** Badge numbers by tab id; a tab without one shows none. */
  counts?: Readonly<Record<string, number>>;
  /** Wires the tabs to their panel ids when set (see the component docs). */
  idPrefix?: string;
  onSelect: (id: string) => void;
  /** Also badge a count of 0 (the pulls list wants every state visible). */
  showZeroCounts?: boolean;
  tabs: readonly { id: string; label: string }[];
  trailing?: View;
}) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    const index = tabs.findIndex((item) => item.id === active);
    let next = -1;

    if (event.key === "ArrowRight") {
      next = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    }

    if (next === -1) {
      return;
    }

    event.preventDefault();
    const target = tabs[next];
    onSelect(target.id);

    const list =
      event.target instanceof HTMLElement
        ? event.target.closest('[role="tablist"]')
        : null;

    list?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div class="border-base-300 flex items-center gap-2 border-b">
      <div class="min-w-0 flex-1 overflow-x-auto">
        <div
          role="tablist"
          class="tabs tabs-border w-max flex-nowrap"
          onkeydown={onKeyDown}
        >
          {tabs.map((item) => {
            const count = counts?.[item.id];

            const showCount =
              count !== undefined && (showZeroCounts || count > 0);

            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={
                  idPrefix === undefined
                    ? undefined
                    : `${idPrefix}-tab-${item.id}`
                }
                aria-controls={
                  idPrefix === undefined
                    ? undefined
                    : `${idPrefix}-panel-${item.id}`
                }
                aria-selected={active === item.id ? "true" : "false"}
                tabindex={active === item.id ? 0 : -1}
                class={`tab gap-1.5 whitespace-nowrap ${active === item.id ? "tab-active" : ""}`}
                onclick={() => {
                  onSelect(item.id);
                }}
              >
                {item.label}
                {showCount ? (
                  <span class="badge badge-sm tabular-nums">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {trailing}
    </div>
  );
};
