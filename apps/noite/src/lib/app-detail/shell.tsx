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
 * of wrapping it into a stack. `trailing` sits at the row's end. */
export const DetailTabs = ({
  active,
  counts,
  onSelect,
  tabs,
  trailing,
}: {
  active: string;
  /** Badge numbers by tab id; a tab without one, or at 0, shows none. */
  counts?: Readonly<Record<string, number>>;
  onSelect: (id: string) => void;
  tabs: readonly { id: string; label: string }[];
  trailing?: View;
}) => (
  <div class="border-base-300 flex items-center gap-2 border-b">
    <div class="min-w-0 flex-1 overflow-x-auto">
      <div role="tablist" class="tabs tabs-border w-max flex-nowrap">
        {tabs.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={active === item.id ? "true" : "false"}
            class={`tab gap-1.5 whitespace-nowrap ${active === item.id ? "tab-active" : ""}`}
            onclick={() => {
              onSelect(item.id);
            }}
          >
            {item.label}
            {(counts?.[item.id] ?? 0) > 0 ? (
              <span class="badge badge-sm tabular-nums">
                {counts?.[item.id]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
    {trailing}
  </div>
);
