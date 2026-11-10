import { defineApp } from "@ilha/model";
import type { UpdateResult } from "@ilha/model";
//! App page chrome and Overview: the header shown above every tab
//! (identity, status, actions) and the Overview tab's cards.
import { Link } from "@ilha/void";
import { watch } from "ilha";

import { appHost, appUrl } from "../apps/identity";
import { formatAgo } from "../dates";
import { errorMessage } from "../errors";
import { appStateUrl, decodeAppState, feedKeys, liveFeed } from "../feeds";
import { islandProps } from "../island";
import { resourceValue, resourceError } from "../resource";
import { appDetail } from "../resources";
import type { AppRole } from "../roles";
import type { FleetHoldInfo } from "../runner-types/FleetHoldInfo";
import { AppStorageList } from "../storage/list";
import { Avatar } from "../ui/avatar";
import { CopyButton } from "../ui/copy-button";
import { ArrowUpRight, Pause, Play, Refresh } from "../ui/icons";
import { AppHeaderSkeleton } from "../ui/skeletons";
import {
  HeaderMsg,
  HeaderNoticeTypes,
  PendingTypes,
  updateHeader,
} from "./app-header.machine";
import type { HeaderMessage, HeaderModel } from "./app-header.machine";
import { capabilities } from "./capabilities";
import { DeployDropdown } from "./deploys";
import { ErrorsSummary } from "./errors";
import { appLifecycle, lifecycleView } from "./lifecycle";
import type { LifecycleView } from "./lifecycle";
import { MetricsCard } from "./metrics";

export interface AppDetailInfo {
  app: {
    desiredState: string;
    fleetBucket: string;
    fleetHold?: FleetHoldInfo | null;
    id: string;
    imported: boolean;
    lastDeploySha: string | null;
    lastError: string | null;
    name: string;
    slug: string;
    status: string;
    subdomain: string;
  };
  gitHint: string;
  gitRemote: string;
  myRole: AppRole;
  s3Endpoint: string;
  username: string;
}

const SHA_CHARS = 7;

/** Status · host · commit, under the app name. The full SHA sits in a
 * native `title` (a daisyUI tooltip's hidden pseudo-element widened the
 * page on phones). */
const IdentityLine = ({
  app,
  view,
}: {
  app: AppDetailInfo["app"];
  view: LifecycleView;
}) => (
  <p class="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <span class="inline-flex items-center gap-1.5">
      <span class={`status ${view.tone}`} aria-hidden="true" />
      {view.label}
      {view.retryAt ? (
        <span class="opacity-70" title={view.retryAt}>
          · {formatAgo(view.retryAt)}
        </span>
      ) : null}
    </span>
    <span class="opacity-30" aria-hidden="true">
      ·
    </span>
    <a
      class="link link-hover min-w-0 truncate opacity-80"
      href={appUrl(app.subdomain)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {appHost(app.subdomain)}
    </a>
    <span class="opacity-30" aria-hidden="true">
      ·
    </span>
    {app.lastDeploySha ? (
      <span class="font-mono opacity-70" title={app.lastDeploySha}>
        {app.lastDeploySha.slice(0, SHA_CHARS)}
      </span>
    ) : (
      <span class="opacity-70">Not deployed</span>
    )}
  </p>
);

const HeaderProps = islandProps<{ appId: string }>("AppHeader");

/** Header above every tab: which app, whether it's up, and what you can do
 * with it (visit, browse code, start/stop, deploy). The Start/Stop and import
 * retry are one machine (`app-header.machine.ts`) fed by the app's state
 * stream: the stream is the authority, and a deadline paints an explicit
 * "still waiting" notice instead of a poll loop that re-enables the button in
 * silence. */
const HeaderApp = defineApp({
  init: (): UpdateResult<HeaderModel, HeaderMessage> => ({
    model: {
      appId: HeaderProps.read().appId,
      notice: HeaderNoticeTypes.None(),
      pending: PendingTypes.Idle(),
      seq: 0,
    } satisfies HeaderModel,
  }),
  update: updateHeader,
  view: (model, dispatch) => {
    const res = appDetail(model.appId);

    // The state stream pushes the runner's row; a frame ends a pending
    // action (convergence) instead of a 3-second poll.
    const feed = liveFeed(
      feedKeys.appState(model.appId),
      appStateUrl(model.appId),
      decodeAppState,
      { persist: false }
    );

    watch(feed.state, (state) => {
      if (state._tag !== "Live" || model.pending._tag === "Idle") {
        return;
      }

      dispatch(
        HeaderMsg.FrameReceived({
          desiredState: state.value.app.desiredState,
          status: state.value.app.status,
        })
      );
    });

    if (res.state()._tag === "Loading") {
      return (
        <header class="flex flex-col gap-3">
          <AppHeaderSkeleton />
        </header>
      );
    }

    const info = resourceValue(res.state());
    const loadError = resourceError(res.state());

    if (!info) {
      return (
        <header class="flex flex-col gap-3">
          <p class="text-error m-0">
            {loadError ? errorMessage(loadError) : "App not found"}
          </p>
        </header>
      );
    }

    const { app } = info;
    const caps = capabilities(info.myRole);
    const lifecycle = appLifecycle(app);
    const view = lifecycleView(lifecycle, app.desiredState);
    const pending = model.pending._tag !== "Idle";

    return (
      <header class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div class="flex min-w-0 items-center gap-3">
            <Avatar class="shrink-0" label={app.name} size="lg" />
            <div class="min-w-0">
              <h1 class="m-0 truncate text-xl font-semibold">{app.name}</h1>
              <IdentityLine app={app} view={view} />
            </div>
          </div>
          {/* Keyed, not positional: the row gains a Stop/Start or Retry
              import control when the app's status lands (a stale snapshot
              paints "Not deployed" first), and without keys the morph would
              pair the new button with the Deploy dropdown's div and replace
              it — closing an open menu and dropping the dropdown's own state.
              Keys make the morph move the dropdown node instead (ilha's keyed
              reconciliation), so focus and state survive the re-render. */}
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <a
              key="visit"
              href={appUrl(app.subdomain)}
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-sm"
            >
              <span class="inline-flex items-center gap-1">
                <ArrowUpRight />
                Visit
              </span>
            </a>
            {caps.push && view.action ? (
              <button
                key="power"
                type="button"
                class="btn btn-sm"
                disabled={pending}
                onclick={() => {
                  dispatch(
                    HeaderMsg.ToggleRequested({
                      next: view.action === "start" ? "running" : "stopped",
                    })
                  );
                }}
              >
                <span class="inline-flex items-center gap-1">
                  {view.action === "start" ? <Play /> : <Pause />}
                  {view.action === "start" ? "Start" : "Stop"}
                </span>
              </button>
            ) : null}
            {caps.push && view.retryable ? (
              <button
                key="retry-import"
                type="button"
                class="btn btn-sm"
                disabled={pending}
                onclick={() => {
                  dispatch(HeaderMsg.RetryRequested());
                }}
              >
                <span class="inline-flex items-center gap-1">
                  <Refresh />
                  Retry import
                </span>
              </button>
            ) : null}
            <DeployDropdown key="deploy" appId={model.appId} />
          </div>
        </div>
        {pending ? (
          <p class="m-0 text-xs opacity-70">
            {model.pending._tag === "Retrying"
              ? "Retry started — waiting for the runner…"
              : "Waiting for the runner to apply the change…"}
          </p>
        ) : null}
        {model.notice._tag === "TimedOut" ? (
          <div class="alert alert-warning m-0 py-2" role="status">
            <span>
              Still waiting for the app to{" "}
              {model.notice.action === "retry"
                ? "finish importing"
                : model.notice.action}
              . The runner has not reported the new state yet.
            </span>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onclick={() => {
                dispatch(HeaderMsg.NoticeDismissed());
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {model.notice._tag === "Failure" ? (
          <div class="alert alert-error m-0 py-2" role="alert">
            <span>{model.notice.message}</span>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onclick={() => {
                dispatch(HeaderMsg.NoticeDismissed());
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {app.lastError ? (
          <div class="alert alert-error alert-soft m-0 py-2" role="alert">
            <span class="text-sm break-words">{app.lastError}</span>
          </div>
        ) : null}
      </header>
    );
  },
});

export const AppHeader = HeaderProps.wrap(HeaderApp);

/** Overview's first card for an app nothing has been pushed to yet (a blank
 * create): the remote and the two commands that deploy it. Gone after the
 * first deploy; an import or template builds on its own, so never shown. */
const FirstPushCard = ({ appId }: { appId: string }) => {
  const info = resourceValue(appDetail(appId).state());

  if (
    !info ||
    info.app.lastDeploySha ||
    info.app.imported ||
    !capabilities(info.myRole).push
  ) {
    return null;
  }

  const snippet = `git remote add noite ${info.gitRemote}\ngit push noite main`;

  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 border">
      <div class="card-body gap-3">
        <h2 class="card-title m-0 text-base">Push your first commit</h2>
        <p class="m-0 text-sm opacity-80">
          This app has no code yet. Push <code>main</code> from your project and
          it deploys.
        </p>
        <div class="bg-base-200 dark:bg-base-300 rounded-box flex items-start gap-2 p-3">
          <pre class="m-0 min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed">
            {snippet}
          </pre>
          <CopyButton iconOnly label="Copy commands" value={snippet} />
        </div>
        <p class="m-0 text-xs opacity-70">
          Git asks for credentials: username <code>{info.username}</code>,
          password an API key from{" "}
          <Link href="/account" class="link">
            Account
          </Link>
          .
        </p>
      </div>
    </section>
  );
};

/** Overview tab: the first-push steps (until something is deployed), usage,
 * open errors, storage. */
export const AppDetailPanel = ({ appId }: { appId: string }) => (
  <div class="@container flex flex-col gap-4">
    <FirstPushCard appId={appId} />
    {/* Columns follow the tab body's width, not the viewport's, so an open
        Settings panel stacks the cards instead of squeezing them. */}
    <div class="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
      <MetricsCard appId={appId} viewAllHref={`/apps/${appId}?t=metrics`} />
      <ErrorsSummary appId={appId} />
    </div>
    <AppStorageList appId={appId} />
  </div>
);
