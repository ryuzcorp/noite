//! App overview panel: header, status, actions, metrics.
import { useRoute } from "@ilha/router";
import { atom, watch } from "ilha";

import { appHost, appUrl, initials, presenceTone } from "../apps";
import { setDesired } from "../apps.server";
import { ArrowLeft, ArrowUpRight, Pause, Play } from "../icons";
import { appDetail } from "../resources";
import type { AppRole } from "../roles";
import { AppHeaderSkeleton } from "../skeletons";
import { sleep } from "../sleep";
import { AppStorageList } from "../storage/list";
import { MetricsCard } from "./metrics";

/** Header status line, rendered from the already-fetched detail (no live
 * subscription — every overview visit used to open an infinite `list()`
 * stream, and unmount cleanup across tab switches is not guaranteed). */
const LiveAppStatus = ({
  app,
}: {
  app: { lastDeploySha: string | null; subdomain: string };
}) => {
  const url = appUrl(app.subdomain);
  const host = appHost(app.subdomain);
  return (
    <p class="m-0 opacity-70">
      <a class="link" href={url} target="_blank" rel="noreferrer">
        {host}
      </a>
      {app.lastDeploySha ? " · " : " · not deployed"}
      {app.lastDeploySha ? (
        <span class="tooltip font-mono" data-tip={app.lastDeploySha}>
          {app.lastDeploySha.slice(0, 12)}
        </span>
      ) : null}
    </p>
  );
};

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

export const AppDetailPanel = () => {
  const { params } = useRoute();
  const { id } = params();
  const res = appDetail(id ?? "");
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
      for (let i = 0; i < 20; i += 1) {
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
        await sleep(3000);
      }
    } finally {
      if (!signal.aborted) {
        converging.set(null);
      }
    }
  });

  if (!id) {
    return (
      <div class="flex flex-col gap-2">
        <p class="text-error">Missing app id</p>
        <a href="/" class="link">
          Back
        </a>
      </div>
    );
  }
  const info = res.data();
  if (res.loading() && info === undefined) {
    return (
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <AppHeaderSkeleton />
        </div>
      </div>
    );
  }
  const loadError = res.error();
  if (loadError && !info) {
    return (
      <div class="flex flex-col gap-2">
        <p class="text-error">{String(loadError)}</p>
        <a href="/" class="link">
          Back
        </a>
      </div>
    );
  }
  if (!info) {
    return null;
  }
  const { app } = info;
  const canPush = info.myRole === "push" || info.myRole === "admin";

  return (
    <div class="flex flex-col gap-4">
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <a
            href="/apps"
            class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
          >
            <ArrowLeft />
            Apps
          </a>
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-3">
              <div class="avatar avatar-placeholder shrink-0">
                <div class="bg-neutral text-neutral-content w-10 rounded-full">
                  <span class="text-sm">{initials(app.name)}</span>
                </div>
                <span
                  class={`status ${presenceTone(app.status)} absolute right-0 bottom-0`}
                  title={app.status}
                />
              </div>
              <div>
                <h1 class="m-0 text-lg font-semibold">{app.name}</h1>
                <LiveAppStatus app={app} />
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
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
              {canPush ? (
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={async () => {
                    const next =
                      app.desiredState === "running" ? "stopped" : "running";
                    try {
                      await setDesired({ desiredState: next, id: app.id });
                      notice.set(null);
                      converging.set(next);
                    } catch (error) {
                      notice.set(
                        error instanceof Error ? error.message : String(error)
                      );
                    }
                  }}
                >
                  <span class="inline-flex items-center gap-1">
                    {app.desiredState === "running" ? <Pause /> : <Play />}
                    {app.desiredState === "running" ? "Stop" : "Start"}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      {app.lastError ? (
        <p class="text-error m-0 text-sm">{app.lastError}</p>
      ) : null}

      <MetricsCard appId={app.id} viewAllHref={`/apps/${app.id}?t=metrics`} />
      <AppStorageList appId={app.id} />
    </div>
  );
};
