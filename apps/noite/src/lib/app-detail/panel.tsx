//! App page chrome and Overview: the header shown above every tab
//! (identity, status, actions) and the Overview tab's cards.
import { atom, watch } from "ilha";

import { api } from "../api";
import { appHost, appUrl, presenceTone } from "../apps/identity";
import { errorMessage } from "../errors";
import { appDetail } from "../resources";
import type { AppRole } from "../roles";
import { sleep } from "../sleep";
import { AppStorageList } from "../storage/list";
import { Avatar } from "../ui/avatar";
import { CopyButton } from "../ui/copy-button";
import { ArrowUpRight, Pause, Play, Refresh } from "../ui/icons";
import { AppHeaderSkeleton } from "../ui/skeletons";
import { DeployDropdown } from "./deploys";
import { ErrorsSummary } from "./errors";
import { MetricsCard } from "./metrics";

export interface AppDetailInfo {
  app: {
    desiredState: string;
    fleetBucket: string;
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
const CONVERGE_POLLS = 20;
const CONVERGE_INTERVAL_MS = 3000;
// Retry of a failed import (A2): the runner's clone can take minutes, and the
// app page is the only place that shows the outcome, so poll the detail.
const IMPORT_POLLS = 60;
const IMPORT_INTERVAL_MS = 3000;
// A failed import offers Retry, and so does one that a restart interrupted
// (still `importing`, with no task behind it — the runner refuses the retry
// while an import really is running).
const RETRY_IMPORT_STATUSES = new Set(["error", "importing"]);

const STATUS_LABELS = new Map([
  ["running", "Running"],
  ["sleeping", "Sleeping"],
  ["stopped", "Stopped"],
  ["deploying", "Deploying"],
  ["building", "Building"],
  ["failed", "Failed"],
  ["error", "Error"],
  ["importing", "Importing"],
]);

const statusLabel = (status: string): string =>
  STATUS_LABELS.get(status) ?? status;

/** Status · host · commit, under the app name. The full SHA sits in a
 * native `title` (a daisyUI tooltip's hidden pseudo-element widened the
 * page on phones). */
const IdentityLine = ({ app }: { app: AppDetailInfo["app"] }) => (
  <p class="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
    <span class="inline-flex items-center gap-1.5">
      <span class={`status ${presenceTone(app.status)}`} aria-hidden="true" />
      {statusLabel(app.status)}
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

/** Header above every tab: which app, whether it's up, and what you can do
 * with it (visit, browse code, start/stop, deploy). */
export const AppHeader = ({ appId }: { appId: string }) => {
  const res = appDetail(appId);
  const notice = atom<string | null>(null);
  const converging = atom<string | null>(null);
  const importBusy = atom(false);

  // The fleet converges asynchronously (reconcile loop), so the first
  // re-fetch still shows the old status. Poll the shared detail until the
  // live status matches or the budget runs out — then stop (never
  // endless). Keyed on the pending state so the watch signal stops it on
  // unmount or when a newer toggle supersedes it.
  watch(converging, async (pending, { signal }) => {
    if (!pending) {
      return;
    }
    try {
      for (let i = 0; i < CONVERGE_POLLS; i += 1) {
        if (signal.aborted) {
          return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential converge poll; parallel makes no sense here
        const fresh = await res.refetch();
        if (signal.aborted) {
          return;
        }
        if (!fresh || fresh.app.status === pending) {
          break;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential converge poll; parallel makes no sense here
        await sleep(CONVERGE_INTERVAL_MS);
      }
    } finally {
      if (!signal.aborted) {
        converging.set(null);
      }
    }
  });

  const info = res.data();
  if (res.loading() && info === undefined) {
    return (
      <header class="flex flex-col gap-3">
        <AppHeaderSkeleton />
      </header>
    );
  }
  const loadError = res.error();
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
  const canPush = info.myRole === "push" || info.myRole === "admin";
  const running = app.desiredState === "running";
  // Never deployed: there is nothing to stop or start yet.
  const deployed = app.status !== "provisioned";

  return (
    <header class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div class="flex min-w-0 items-center gap-3">
          <Avatar class="shrink-0" label={app.name} size="lg" />
          <div class="min-w-0">
            <h1 class="m-0 truncate text-xl font-semibold">{app.name}</h1>
            <IdentityLine app={app} />
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <a
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
          {canPush && deployed ? (
            <button
              type="button"
              class="btn btn-sm"
              disabled={converging() !== null}
              onclick={async () => {
                const next = running ? "stopped" : "running";
                try {
                  await api<{ ok: true }>("/api/apps/setDesired", {
                    desiredState: next,
                    id: app.id,
                  });
                  notice.set(null);
                  converging.set(next);
                } catch (error) {
                  notice.set(errorMessage(error));
                }
              }}
            >
              <span class="inline-flex items-center gap-1">
                {running ? <Pause /> : <Play />}
                {running ? "Stop" : "Start"}
              </span>
            </button>
          ) : null}
          {canPush && app.imported && RETRY_IMPORT_STATUSES.has(app.status) ? (
            <button
              type="button"
              class="btn btn-sm"
              disabled={importBusy()}
              onclick={async () => {
                importBusy.set(true);
                try {
                  await api<{ ok: true }>("/api/apps/retryImport", app.id);
                  notice.set(null);
                  // The import runs in the background: poll the shared detail
                  // until the app leaves `importing` (then the deploy, or a
                  // fresh error, is what the page shows).
                  for (let i = 0; i < IMPORT_POLLS; i += 1) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
                    await sleep(IMPORT_INTERVAL_MS);
                    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll; parallel makes no sense here
                    const fresh = await res.refetch();
                    if (!fresh || fresh.app.status !== "importing") {
                      break;
                    }
                  }
                } catch (error) {
                  notice.set(errorMessage(error));
                }
                importBusy.set(false);
              }}
            >
              <span class="inline-flex items-center gap-1">
                <Refresh />
                Retry import
              </span>
            </button>
          ) : null}
          <DeployDropdown appId={appId} />
        </div>
      </div>
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}
      {app.lastError ? (
        <div class="alert alert-error alert-soft m-0 py-2" role="alert">
          <span class="text-sm break-words">{app.lastError}</span>
        </div>
      ) : null}
    </header>
  );
};

/** Overview's first card for an app nothing has been pushed to yet (a blank
 * create): the remote and the two commands that deploy it. Gone after the
 * first deploy; an import or template builds on its own, so never shown. */
const FirstPushCard = ({ appId }: { appId: string }) => {
  const info = appDetail(appId).data();
  if (
    !info ||
    info.app.lastDeploySha ||
    info.app.imported ||
    !(info.myRole === "push" || info.myRole === "admin")
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
          <a href="/account" class="link">
            Account
          </a>
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
