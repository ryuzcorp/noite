/** Code mode's top bar, shared by the source page and every page under it
 * (commit, compare): the source page's branch picker or a sub-page's link
 * back to the files on the left, the panel toggles on the right. Changes
 * only exists on the source page, where the drafts live. */
import { Link } from "@ilha/void";
import type { View } from "ilha";

import { appDetail } from "../resources";
import { ArrowLeft, FileDiff, HistoryIcon, Monitor } from "../ui/icons";
import { sourceQuery } from "./format";
import type { SourceFrom } from "./format";

export const CODE_PANELS = [
  { icon: HistoryIcon, id: "history", label: "History" },
  { icon: FileDiff, id: "changes", label: "Changes" },
  { icon: Monitor, id: "preview", label: "Preview" },
] as const;

/** The source page's side panel: `""` is closed. */
export type CodePanel = (typeof CODE_PANELS)[number]["id"] | "";

/** Parse `?panel=`: unknown values close the panel. */
export const toCodePanel = (raw: string): CodePanel =>
  CODE_PANELS.find((panel) => panel.id === raw)?.id ?? "";

/** The changed-file count on the Changes toggle. `count` reads an atom, and
 * calling it here subscribes only this badge: a keystroke repaints the number,
 * never the bar or the page. It sits on the button's corner, out of the flow,
 * so the button keeps the size of its siblings whatever the count. */
const ChangeBadge = ({ count }: { count: () => number }) => {
  const changed = count();
  if (changed === 0) {
    return null;
  }
  // The badge holds the number alone; the words around it are for screen
  // readers only ("Changes, 2 changed").
  return (
    <>
      <span class="sr-only">, </span>
      <span class="badge badge-xs badge-primary pointer-events-none absolute -top-1.5 -right-1.5 min-w-4 px-1 tabular-nums">
        {changed}
      </span>
      <span class="sr-only"> changed</span>
    </>
  );
};

/** `/source?panel=` link that also keeps the browsed ref and open file. */
const sourcePanelHref = (
  appId: string,
  panel: string,
  { file, ref }: SourceFrom
): string => {
  const params = new URLSearchParams({ panel });
  if (ref !== "") {
    params.set("ref", ref);
  }
  if (file !== "") {
    params.set("file", file);
  }
  return `/apps/${appId}/source?${params}`;
};

/** The panel toggles. The source page opens and closes its panel in place
 * (`onToggle`) and passes `changeCount`; the pages below it link to
 * `/source?panel=` and have no Changes, carrying the browsed ref and open file
 * so History opens on what the user left. */
export const PanelToggles = ({
  active,
  appId,
  changeCount,
  file = "",
  gitRef = "",
  onToggle,
}: {
  active: CodePanel;
  appId: string;
  changeCount?: () => number;
  file?: string;
  gitRef?: string;
  onToggle?: (panel: CodePanel) => void;
}) => (
  <nav class="flex items-center gap-1" aria-label="Code panels">
    {CODE_PANELS.map((entry) => {
      if (entry.id === "changes" && !changeCount) {
        return null;
      }
      const open = active === entry.id;
      const cls = `btn btn-sm relative ${open ? "btn-neutral" : "btn-ghost"}`;
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
        <Link
          key={entry.id}
          class={cls}
          href={sourcePanelHref(appId, entry.id, { file, ref: gitRef })}
        >
          {label}
        </Link>
      );
    })}
  </nav>
);

/** The pages below the source page link back to it, labelled with the app's
 * name, returning to the ref and file the user came from; the source page
 * itself has no back link (the sidebar lists the apps). */
const CodeBackLink = ({ appId, from }: { appId: string; from: SourceFrom }) => (
  <Link
    href={`/apps/${appId}/source${sourceQuery(from)}`}
    class="link link-hover inline-flex w-fit shrink-0 items-center gap-1 text-sm opacity-70"
  >
    <ArrowLeft class="h-4 w-4" />
    <span>{appDetail(appId).data()?.app.name ?? "…"}</span>
  </Link>
);

/** Layout for a page below the source page: the Code bar, then the page. */
export const CodePage = ({
  appId,
  backFile = "",
  backRef = "",
  children,
}: {
  appId: string;
  /** The ref and open file the sub-page was opened from, so the back link and
   * the panel links return to them. */
  backFile?: string;
  backRef?: string;
  children: View;
}) => {
  const from = { file: backFile, ref: backRef };
  return (
    <div class="flex min-h-screen w-full flex-col">
      <div class="border-base-300 flex items-center justify-between gap-2 border-b px-4 py-2">
        <CodeBackLink appId={appId} from={from} />
        <PanelToggles
          active=""
          appId={appId}
          file={backFile}
          gitRef={backRef}
        />
      </div>
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-4 pb-12">
        {children}
      </div>
    </div>
  );
};
