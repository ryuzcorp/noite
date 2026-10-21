import { Link } from "@ilha/void";
/** Pull-request detail: header (title, state and the Close/Merge actions),
 * the head branch's environment card, the review box, and the
 * Conversation/Files tabs. */
import { atom } from "ilha";

import { CreateEnvironmentDialog } from "../app-detail/environments";
import {
  environmentHost,
  environmentUrl,
  presenceTone,
} from "../apps/identity";
import { formatDateTime } from "../dates";
import { shortSha } from "../forge/format";
import { CommitList } from "../forge/parts";
import { appDetail, environments } from "../resources";
import type { PrDetail } from "../runner";
import { searchParam } from "../search-param";
import type { SearchParam } from "../search-param";
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";
import { PrConversationTab } from "./conversation";
import { latestReviews } from "./data";
import { PrFilesTab } from "./files";
import { PrHeaderActions, PrMergeState, PrReviewBox } from "./merge-box";
import { prDetail, prNames, prViewer } from "./resources";
import { nameFor, PrStateBadge } from "./widgets";

const VIEWS = ["conversation", "commits", "files"] as const;

type DetailView = (typeof VIEWS)[number];

const toView = (raw: string): DetailView =>
  VIEWS.find((view) => view === raw) ?? "conversation";

const VIEW_LABELS: Record<DetailView, string> = {
  commits: "Commits",
  conversation: "Conversation",
  files: "Files",
};

/** The tab row: roving tabindex, Left/Right/Home/End move and select, and the
 * panel is wired back with `aria-controls`/`aria-labelledby`. */
const ViewTabs = ({ view }: { view: SearchParam<DetailView> }) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    const index = VIEWS.indexOf(view());
    let next = -1;

    if (event.key === "ArrowRight") {
      next = (index + 1) % VIEWS.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + VIEWS.length) % VIEWS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = VIEWS.length - 1;
    }

    if (next === -1) {
      return;
    }

    event.preventDefault();
    const target = VIEWS[next];
    view.set(target);
    document.querySelector<HTMLElement>(`#pr-tab-${target}`)?.focus();
  };

  return (
    <div role="tablist" class="tabs tabs-border" onkeydown={onKeyDown}>
      {VIEWS.map((entry) => (
        <button
          key={entry}
          type="button"
          role="tab"
          id={`pr-tab-${entry}`}
          aria-controls={`pr-panel-${entry}`}
          aria-selected={view() === entry ? "true" : "false"}
          tabindex={view() === entry ? 0 : -1}
          class={`tab ${view() === entry ? "tab-active" : ""}`}
          onclick={() => {
            view.set(entry);
          }}
        >
          {VIEW_LABELS[entry]}
        </button>
      ))}
    </div>
  );
};

/** The commits only on the head branch (oldest first, like the compare page),
 * each linking to its commit page. */
const PrCommitsTab = ({
  appId,
  detail,
}: {
  appId: string;
  detail: PrDetail;
}) => {
  const { compare } = detail;

  if (compare === null) {
    return (
      <p class="m-0 text-sm opacity-70">
        The head branch is gone — the commits cannot be listed.
      </p>
    );
  }

  return (
    <CommitList
      appId={appId}
      commits={compare.commits}
      emptyLabel={`No commits between ${compare.base} and ${compare.head}.`}
      gitRef={compare.head}
    />
  );
};

/** The head branch's own environment, when it has one (a preview environment
 * is per branch; `main` never has one). Status, URL, last deploy and links
 * into that environment's Metrics/Errors — all from the cached app detail
 * and environments the page's state stream keeps fresh (`AppStateSync`,
 * mounted by the layout), so this opens no second event stream. */
const PrEnvironment = ({ appId, head }: { appId: string; head: string }) => {
  const environment = (environments(appId).data() ?? []).find(
    (row) => row.gitRef === `refs/heads/${head}`
  );

  const detail = appDetail(appId).data();
  const subdomain = detail?.app.subdomain ?? "";
  const role = detail?.myRole;
  const canPush = role === "push" || role === "admin";
  const createOpen = atom(false);

  if (!environment) {
    if (!canPush) {
      return null;
    }

    return (
      <div class="border-base-300 bg-base-100 dark:bg-base-200 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
        <span class="opacity-70">No environment for {head} yet.</span>
        <button
          type="button"
          class="btn btn-sm btn-neutral"
          onclick={() => {
            createOpen.set(true);
          }}
        >
          Create environment
        </button>
        <CreateEnvironmentDialog
          appId={appId}
          initialBranch={head}
          open={createOpen}
        />
      </div>
    );
  }

  return (
    <div class="border-base-300 bg-base-100 dark:bg-base-200 flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span class="opacity-70">Environment</span>
        <span class="font-mono text-xs">{environment.label}</span>
        <span class={`status ${presenceTone(environment.status)}`}>
          <span class="sr-only">{environment.status}</span>
        </span>
        <span class="text-xs">{environment.status}</span>
        {subdomain === "" ? null : (
          <a
            class="link link-hover ml-auto font-mono text-xs"
            href={environmentUrl(subdomain, environment.label)}
            target="_blank"
            rel="noopener"
            title={environmentHost(subdomain, environment.label)}
          >
            Open environment
          </a>
        )}
      </div>
      <div class="text-base-content/70 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {environment.lastDeploySha ? (
          <>
            <span>
              {shortSha(environment.lastDeploySha)} ·{" "}
              {formatDateTime(
                environment.lastDeployedAt ?? environment.updatedAt
              )}
            </span>
            <Link
              class="link link-hover"
              href={`/apps/${appId}?t=deployments&env=${environment.id}`}
            >
              Deploy log
            </Link>
          </>
        ) : (
          <span>no deploy yet</span>
        )}
        <span aria-hidden="true">·</span>
        <Link href={`/apps/${appId}?t=metrics&env=${environment.id}`}>
          Metrics
        </Link>
        <span aria-hidden="true">·</span>
        <Link href={`/apps/${appId}?t=errors&env=${environment.id}`}>
          Errors
        </Link>
      </div>
    </div>
  );
};

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
        <LoadError error={error} label="Failed to load pull request" />
        {error ? null : <SectionSkeleton lines={5} />}
      </div>
    );
  }

  const { pullRequest } = detail;

  const requesting = latestReviews(detail.reviews).filter(
    (review) =>
      review.state === "changes_requested" && review.dismissedAt === null
  );

  const compareHref = `/apps/${appId}/source/compare?base=${encodeURIComponent(
    pullRequest.base
  )}&head=${encodeURIComponent(pullRequest.head)}`;

  return (
    <div class="flex flex-col gap-4">
      <header class="flex flex-col gap-2">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <h1 class="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xl font-semibold break-words">
            <span class="min-w-0">{pullRequest.title}</span>
            <span class="text-base-content/70 font-mono text-base">
              #{pullRequest.number}
            </span>
            <PrStateBadge state={pullRequest.state} />
          </h1>
          <PrHeaderActions
            appId={appId}
            detail={detail}
            role={role}
            viewerId={viewer?.id ?? ""}
          />
        </div>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {pullRequest.state === "open" ? (
            <PrMergeState detail={detail} />
          ) : null}
          <span class="text-base-content/70">
            {nameFor(names, pullRequest.authorId)} wants to merge
          </span>
          <span class="font-mono text-xs">
            <Link
              class="link link-hover"
              href={`/apps/${appId}/source?ref=${encodeURIComponent(pullRequest.head)}`}
            >
              {pullRequest.head}
            </Link>{" "}
            into{" "}
            <Link
              class="link link-hover"
              href={`/apps/${appId}/source?ref=${encodeURIComponent(pullRequest.base)}`}
            >
              {pullRequest.base}
            </Link>
          </span>
          <Link class="link link-hover text-xs" href={compareHref}>
            Compare
          </Link>
        </div>
        {requesting.length > 0 ? (
          <p class="text-warning m-0 text-sm" role="status">
            {requesting
              .map((review) => nameFor(names, review.reviewerId))
              .join(", ")}{" "}
            requested changes.
          </p>
        ) : null}
        <PrEnvironment appId={appId} head={pullRequest.head} />
      </header>

      <PrReviewBox
        appId={appId}
        detail={detail}
        role={role}
        viewerId={viewer?.id ?? ""}
      />
      <div class="flex min-w-0 flex-col gap-4">
        <ViewTabs view={view} />
        <div
          id={`pr-panel-${view()}`}
          role="tabpanel"
          aria-labelledby={`pr-tab-${view()}`}
          tabindex={0}
          class="flex min-w-0 flex-col gap-4"
        >
          {view() === "conversation" ? (
            <PrConversationTab
              appId={appId}
              detail={detail}
              names={names}
              role={role}
              viewerId={viewer?.id ?? ""}
            />
          ) : null}
          {view() === "commits" ? (
            <PrCommitsTab appId={appId} detail={detail} />
          ) : null}
          {view() === "files" ? (
            <PrFilesTab
              appId={appId}
              detail={detail}
              names={names}
              role={role}
              viewerId={viewer?.id ?? ""}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};
