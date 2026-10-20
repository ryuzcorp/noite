//! Keeps every status badge on an app's pages in step with the runner.
//!
//! The header's status, the Deployments tab's Production and environment
//! dots, Code mode's Preview panel and the pull request environment card all
//! read the cached `appDetail` and `environments` resources, which were
//! fetched once: after a deploy, a stop or a sleep they kept the old status
//! while the sidebar's live app list moved on. While an app's pages are open,
//! its state stream (`/api/apps/:id/state/stream`) re-sends the app row and
//! its environments on every change, and a frame that disagrees with a cache
//! invalidates it, so every reader refetches the same truth.
import { watch } from "ilha";

import type { AppDetail } from "../api-types";
import { appStateUrl, decodeAppState, feedKeys, liveFeed } from "../feeds";
import { invalidate } from "../resource";
import { keys } from "../resources";
import type { RunnerAppState, RunnerEnvironment } from "../runner";
import { readSwr } from "../swr-store";

/** What a page shows of one environment: a change in any of these is one a
 * badge or a header must follow. */
const envShown = (env: RunnerEnvironment): string =>
  JSON.stringify([
    env.status,
    env.desiredState,
    env.lastDeploySha,
    env.lastError,
    env.public,
    env.asleepSince,
  ]);

/** The cache keys `frame` proves stale. A cache never fetched is left alone:
 * its first fetch reads the runner itself. Exported for the unit tests. */
export const staleKeys = (
  appId: string,
  frame: RunnerAppState,
  detail?: AppDetail,
  environments?: readonly RunnerEnvironment[]
): string[] => {
  const stale: string[] = [];

  if (detail !== undefined) {
    const shown = detail.app;
    const live = frame.app;

    if (
      shown.status !== live.status ||
      shown.desiredState !== live.desiredState ||
      shown.lastDeploySha !== live.lastDeploySha ||
      shown.lastError !== live.lastError ||
      shown.asleepSince !== live.asleepSince ||
      shown.name !== live.name ||
      shown.slug !== live.slug ||
      shown.subdomain !== live.subdomain
    ) {
      stale.push(keys.appDetail(appId));
    }
  }

  if (environments !== undefined) {
    const cached = new Map(environments.map((env) => [env.id, envShown(env)]));

    const moved =
      cached.size !== frame.environments.length ||
      frame.environments.some((env) => cached.get(env.id) !== envShown(env));

    if (moved) {
      stale.push(keys.environments(appId));
    }
  }

  return stale;
};

/** Follow one app's state stream and invalidate whichever cache it proves
 * stale. Renders nothing. */
const AppStateSync = ({ appId }: { appId: string }) => {
  const feed = liveFeed(
    feedKeys.appState(appId),
    appStateUrl(appId),
    decodeAppState
  );

  watch(feed.latest, (frame) => {
    // Only a frame the open stream delivered: the snapshot `latest` starts
    // from is a previous visit's, older than the caches it would invalidate.
    if (frame === undefined || feed.status() !== "open") {
      return;
    }

    const stale = staleKeys(
      appId,
      frame,
      readSwr<AppDetail>(keys.appDetail(appId)),
      readSwr<RunnerEnvironment[]>(keys.environments(appId))
    );

    for (const key of stale) {
      invalidate(key);
    }
  });

  return null;
};

/** Mount point for the app the page shows. Its view is a one-item keyed
 * list so the layout's repaints reuse the sync (and its stream), while a
 * move to another app remounts it on that app's stream. */
export const AppStateSyncSlot = ({ appId }: { appId: string }) => [
  <AppStateSync key={appId} appId={appId} />,
];
