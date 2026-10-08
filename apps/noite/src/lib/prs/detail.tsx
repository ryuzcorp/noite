import { appDetail } from "../resources";
/** Pull-request detail: header, Conversation/Files tabs and the merge box. */
import { searchParam } from "../search-param";
import type { SearchParam } from "../search-param";
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";
import { PrConversationTab } from "./conversation";
import { PrFilesTab } from "./files";
import { PrMergeBox } from "./merge-box";
import { prDetail, prNames, prViewer } from "./resources";
import { nameFor, PrStateBadge } from "./widgets";

const VIEWS = ["conversation", "files"] as const;

type DetailView = (typeof VIEWS)[number];

const toView = (raw: string): DetailView =>
  VIEWS.find((view) => view === raw) ?? "conversation";

const ViewTabs = ({ view }: { view: SearchParam<DetailView> }) => (
  <div role="tablist" class="tabs tabs-border">
    {VIEWS.map((entry) => (
      <button
        key={entry}
        type="button"
        role="tab"
        aria-selected={view() === entry ? "true" : "false"}
        class={`tab capitalize ${view() === entry ? "tab-active" : ""}`}
        onclick={() => {
          view.set(entry);
        }}
      >
        {entry}
      </button>
    ))}
  </div>
);

export const PrDetailView = ({
  appId,
  number,
}: {
  appId: string;
  number: number;
}) => {
  const view = searchParam<DetailView>("view", {
    default: "conversation",
    parse: toView,
  });
  const res = prDetail(appId, number);
  const detail = res.data();
  const error = res.error();
  const viewer = prViewer(appId).data();
  // `myRole` comes from the cached app detail; the viewer action covers a
  // cold cache and the standalone page.
  const role = appDetail(appId).data()?.myRole ?? viewer?.role;
  const names = prNames(
    appId,
    detail === undefined
      ? []
      : [
          detail.pullRequest.authorId,
          ...detail.comments.map((comment) => comment.authorId),
          ...detail.reviews.map((review) => review.reviewerId),
        ]
  ).data();

  if (detail === undefined) {
    return (
      <div class="flex flex-col gap-4">
        <LoadError error={error} label="Failed to load pull" />
        {error ? null : <SectionSkeleton lines={5} />}
      </div>
    );
  }

  const { pullRequest } = detail;
  return (
    <div class="flex flex-col gap-4">
      <header class="flex flex-col gap-2">
        <h1 class="m-0 text-xl font-semibold break-words">
          {pullRequest.title}{" "}
          <span class="text-base-content/70 font-mono text-base">
            #{pullRequest.number}
          </span>
        </h1>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <PrStateBadge state={pullRequest.state} />
          <span class="text-base-content/70">
            {nameFor(names, pullRequest.authorId)} wants to merge
          </span>
          <span class="font-mono text-xs">
            {pullRequest.head} into {pullRequest.base}
          </span>
        </div>
      </header>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div class="flex min-w-0 flex-col gap-4">
          <ViewTabs view={view} />
          {view() === "conversation" ? (
            <PrConversationTab
              appId={appId}
              detail={detail}
              names={names}
              role={role}
              viewerId={viewer?.id ?? ""}
            />
          ) : (
            <PrFilesTab
              appId={appId}
              detail={detail}
              names={names}
              role={role}
              viewerId={viewer?.id ?? ""}
            />
          )}
        </div>
        <aside class="min-w-0">
          <PrMergeBox
            appId={appId}
            detail={detail}
            role={role}
            viewerId={viewer?.id ?? ""}
          />
        </aside>
      </div>
    </div>
  );
};
