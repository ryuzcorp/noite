//! App overview panel: header, status, actions, metrics.
import { navigate, useRoute } from "@ilha/router";
import { atom, unsafe, watch } from "ilha";

import { appHost, appUrl, initials, presenceTone } from "../apps";
import { get, setDesired } from "../apps.server";
import { authClient } from "../auth-client";
import type { AppRole } from "../roles";
import { AppHeaderSkeleton } from "../skeletons";
import { sleep } from "../sleep";
import { AppStorageList } from "../storage/list";
import { readSwrCache, writeSwrCache } from "../swr-cache";
import {
  ARROW_LEFT_SVG,
  ARROW_UP_RIGHT_SVG,
  PAUSE_SVG,
  PLAY_SVG,
} from "./icons";
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
  // Cache-first: seed from the last good value at creation so first paint
  // carries data on every mount; watch.once revalidates in background.
  const seed = (() => {
    const { id } = params();
    return id ? readSwrCache<AppDetailInfo>(`app:${id}:detail`) : null;
  })();
  const ready = atom(seed !== null);
  const detail = atom<AppDetailInfo | null>(seed);
  const loadError = atom("");
  const notice = atom<string | null>(null);

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        navigate("/login");
        return;
      }
      const { id } = params();
      if (!id) {
        loadError.set("Missing app id");
        ready.set(true);
        return;
      }
      const cached = readSwrCache<AppDetailInfo>(`app:${id}:detail`);
      if (cached) {
        detail.set(cached);
      }
      try {
        const info = await get(id);
        detail.set(info);
        writeSwrCache(`app:${id}:detail`, info);
        ready.set(true);
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
        ready.set(true);
      }
    })();
  });

  if (!ready()) {
    return (
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <AppHeaderSkeleton />
        </div>
      </div>
    );
  }
  if (loadError() && !detail()) {
    return (
      <div class="flex flex-col gap-2">
        <p class="text-error">{loadError()}</p>
        <a href="/" class="link">
          Back
        </a>
      </div>
    );
  }
  const info = detail();
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
            {unsafe(ARROW_LEFT_SVG)}
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
                  {unsafe(ARROW_UP_RIGHT_SVG)}
                  Visit
                </span>
              </a>
              {canPush && app.desiredState !== "deleted" ? (
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={async () => {
                    const next =
                      app.desiredState === "running" ? "stopped" : "running";
                    try {
                      await setDesired({ desiredState: next, id: app.id });
                      notice.set(null);
                      // The fleet converges asynchronously (reconcile loop),
                      // so the first re-fetch still shows the old status.
                      // Poll until the live status matches or the budget
                      // runs out — then stop (never endless).
                      let fresh = await get(app.id);
                      detail.set(fresh);
                      writeSwrCache(`app:${app.id}:detail`, fresh);
                      for (
                        let i = 0;
                        i < 20 && fresh.app.status !== next;
                        i += 1
                      ) {
                        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential converge poll; parallel makes no sense here
                        await sleep(3000);
                        // oxlint-disable-next-line eslint/no-await-in-loop -- same poll cycle: sleep, then read
                        fresh = await get(app.id);
                        detail.set(fresh);
                        writeSwrCache(`app:${app.id}:detail`, fresh);
                      }
                    } catch (error) {
                      notice.set(
                        error instanceof Error ? error.message : String(error)
                      );
                    }
                  }}
                >
                  <span class="inline-flex items-center gap-1">
                    {unsafe(
                      app.desiredState === "running" ? PAUSE_SVG : PLAY_SVG
                    )}
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
