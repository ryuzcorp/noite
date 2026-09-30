//! App page chrome and Overview: the header shown above every tab
//! (identity, status, actions) and the Overview tab's cards.
import { atom, watch } from "ilha";

import { appHost, appUrl, initials, presenceTone } from "../apps";
import { setDesired } from "../apps.server";
import { errorMessage } from "../errors";
import { ArrowLeft, ArrowUpRight, Code, Pause, Play } from "../icons";
import { appDetail } from "../resources";
import type { AppRole } from "../roles";
import { AppHeaderSkeleton } from "../skeletons";
import { sleep } from "../sleep";
import { AppStorageList } from "../storage/list";
import { DeployDropdown } from "./deploys";
import { ErrorsSummary } from "./errors";
import { MetricsCard } from "./metrics";

export interface AppDetailInfo {
  app: {
    desiredState: string;
    fleetBucket: string;
    id: string;
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

const STATUS_LABELS = new Map([
  ["running", "Running"],
  ["sleeping", "Sleeping"],
  ["stopped", "Stopped"],
  ["deploying", "Deploying"],
  ["building", "Building"],
  ["failed", "Failed"],
  ["error", "Error"],
]);

const statusLabel = (status: string): string =>
  STATUS_LABELS.get(status) ?? status;

const BackToApps = () => (
  <a
    href="/apps"
    class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
  >
    <ArrowLeft />
    Apps
  </a>
);

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
        <BackToApps />
        <AppHeaderSkeleton />
      </header>
    );
  }
  const loadError = res.error();
  if (!info) {
    return (
      <header class="flex flex-col gap-3">
        <BackToApps />
        <p class="text-error m-0">
          {loadError ? errorMessage(loadError) : "App not found"}
        </p>
      </header>
    );
  }
  const { app } = info;
  const canPush = info.myRole === "push" || info.myRole === "admin";
  const running = app.desiredState === "running";

  return (
    <header class="flex flex-col gap-3">
      <BackToApps />
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div class="flex min-w-0 items-center gap-3">
          <div class="avatar avatar-placeholder shrink-0">
            <div class="bg-neutral text-neutral-content w-11 rounded-full">
              <span>{initials(app.name)}</span>
            </div>
          </div>
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
          <a href={`/apps/${appId}/source`} class="btn btn-sm">
            <span class="inline-flex items-center gap-1">
              <Code />
              Code
            </span>
          </a>
          {canPush ? (
            <button
              type="button"
              class="btn btn-sm"
              disabled={converging() !== null}
              onclick={async () => {
                const next = running ? "stopped" : "running";
                try {
                  await setDesired({ desiredState: next, id: app.id });
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

/** Overview tab: usage, open errors, storage. */
export const AppDetailPanel = ({ appId }: { appId: string }) => (
  <div class="flex flex-col gap-4">
    <MetricsCard appId={appId} viewAllHref={`/apps/${appId}?t=metrics`} />
    <ErrorsSummary appId={appId} />
    <AppStorageList appId={appId} />
  </div>
);
