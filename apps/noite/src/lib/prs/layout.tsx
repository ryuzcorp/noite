/** The pulls pages' frame (`/apps/[id]/pulls…`, beside App and Code in the
 * sidebar) and the open-pull count the sidebar and the list title show. */
import type { View } from "ilha";

import { ArrowLeft } from "../ui/icons";
import { prList } from "./resources";

/** The open-pull count: hidden at zero unless `showZero` (the list title,
 * once the list has loaded). Its own component, so the list request landing
 * re-renders only the badge, never the page or sidebar around it. */
export const OpenPrBadge = ({
  appId,
  class: extra = "",
  showZero = false,
}: {
  appId: string;
  class?: string;
  showZero?: boolean;
}) => {
  const open = prList(appId, "open").data()?.counts.open;
  if (open === undefined || (open === 0 && !showZero)) {
    return null;
  }
  return <span class={`badge badge-sm tabular-nums ${extra}`}>{open}</span>;
};

/** One pulls page. `back` set: a pull or the new-pull form, which link back
 * to the list. */
export const PullsPage = ({
  appId,
  back = false,
  children,
}: {
  appId: string;
  back?: boolean;
  children: View;
}) => (
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-4 pb-12">
    {back ? (
      <a
        href={`/apps/${appId}/pulls`}
        class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
      >
        <ArrowLeft class="h-4 w-4" />
        Pulls
      </a>
    ) : null}
    {children}
  </div>
);
