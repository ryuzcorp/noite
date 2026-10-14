/** The pull-request pages' frame (`/apps/[id]/pulls…`, beside App and Code in
 * the sidebar) and the open count the sidebar shows. */
import type { View } from "ilha";

import { DetailShell } from "../app-detail/shell";
import { ArrowLeft } from "../ui/icons";
import { prList } from "./resources";

/** The open-pull count, hidden at zero. Its own component, so the list
 * request landing re-renders only the badge, never the sidebar around it. */
export const OpenPrBadge = ({
  appId,
  class: extra = "",
}: {
  appId: string;
  class?: string;
}) => {
  const open = prList(appId, "open").data()?.counts.open;
  if (open === undefined || open === 0) {
    return null;
  }
  return <span class={`badge badge-sm tabular-nums ${extra}`}>{open}</span>;
};

/** One pulls page, on the detail layout the app pages use: `header` stays put
 * above the scrolling body. `back` set: a pull or the new-pull form, which
 * link back to the list. */
export const PullsPage = ({
  appId,
  back = false,
  children,
  header = null,
}: {
  appId: string;
  back?: boolean;
  children: View;
  header?: View | null;
}) => (
  <DetailShell
    header={
      <>
        {back ? (
          <a
            href={`/apps/${appId}/pulls`}
            class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
          >
            <ArrowLeft class="h-4 w-4" />
            Pull requests
          </a>
        ) : null}
        {header}
      </>
    }
    panel={null}
  >
    {children}
  </DetailShell>
);
