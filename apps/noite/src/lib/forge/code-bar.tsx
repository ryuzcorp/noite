/** Code mode's top bar, shared by the source page and every page under it
 * (commit, compare): the source page's branch picker or a sub-page's link
 * back to the files on the left, the panel toggles on the right. Changes
 * only exists on the source page, where the drafts live. */
import type { View } from "ilha";

import { appDetail } from "../resources";
import { ArrowLeft, FileDiff, HistoryIcon } from "../ui/icons";

export const CODE_PANELS = [
  { icon: HistoryIcon, id: "history", label: "History" },
  { icon: FileDiff, id: "changes", label: "Changes" },
] as const;

/** The source page's side panel: `""` is closed. */
export type CodePanel = (typeof CODE_PANELS)[number]["id"] | "";

/** Parse `?panel=`: unknown values close the panel. */
export const toCodePanel = (raw: string): CodePanel =>
  CODE_PANELS.find((panel) => panel.id === raw)?.id ?? "";

/** The changed-file count beside Changes. `count` reads an atom, and calling
 * it here subscribes only this badge: a keystroke repaints the number, never
 * the bar or the page. */
const ChangeBadge = ({ count }: { count: () => number }) => {
  const changed = count();
  return changed > 0 ? (
    <span class="badge badge-sm ml-1.5 tabular-nums">{changed}</span>
  ) : null;
};

/** The panel toggles. The source page opens and closes its panel in place
 * (`onToggle`) and passes `changeCount`; the pages below it link to
 * `/source?panel=` and have no Changes. */
export const PanelToggles = ({
  active,
  appId,
  changeCount,
  onToggle,
}: {
  active: CodePanel;
  appId: string;
  changeCount?: () => number;
  onToggle?: (panel: CodePanel) => void;
}) => (
  <nav class="flex items-center gap-1" aria-label="Code panels">
    {CODE_PANELS.map((entry) => {
      if (entry.id === "changes" && !changeCount) {
        return null;
      }
      const open = active === entry.id;
      const cls = `btn btn-sm ${open ? "btn-neutral" : "btn-ghost"}`;
      const label = (
        <>
          <entry.icon />
          {entry.label}
          {entry.id === "changes" && changeCount ? (
            <ChangeBadge count={changeCount} />
          ) : null}
        </>
      );
      return onToggle ? (
        <button
          key={entry.id}
          type="button"
          class={cls}
          aria-pressed={open ? "true" : "false"}
          onclick={() => {
            onToggle(open ? "" : entry.id);
          }}
        >
          {label}
        </button>
      ) : (
        <a
          key={entry.id}
          class={cls}
          href={`/apps/${appId}/source?panel=${entry.id}`}
        >
          {label}
        </a>
      );
    })}
  </nav>
);

/** The pages below the source page link back to it, labelled with the app's
 * name; the source page itself has no back link (the sidebar lists the
 * apps). */
const CodeBackLink = ({ appId }: { appId: string }) => (
  <a
    href={`/apps/${appId}/source`}
    class="link link-hover inline-flex w-fit shrink-0 items-center gap-1 text-sm opacity-70"
  >
    <ArrowLeft class="h-4 w-4" />
    <span>{appDetail(appId).data()?.app.name ?? "…"}</span>
  </a>
);

/** Layout for a page below the source page: the Code bar, then the page. */
export const CodePage = ({
  appId,
  children,
}: {
  appId: string;
  children: View;
}) => (
  <div class="flex min-h-screen w-full flex-col">
    <div class="border-base-300 flex items-center justify-between gap-2 border-b px-4 py-2">
      <CodeBackLink appId={appId} />
      <PanelToggles active="" appId={appId} />
    </div>
    <div class="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-4 pb-12">
      {children}
    </div>
  </div>
);
