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
//!
//! One frame moves the sync through {@link syncPlan}:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Cold: no cache (left to its own fetch)
//!   [*] --> Warm: cached detail/environments
//!   Warm --> Warm: frame agrees
//!   Warm --> Stale: frame disagrees
//!   Stale --> Warm: invalidate → refetch
//!   Cold --> Warm: first fetch lands
//! ```
//!
//! A frame is compared on every `Live` state, including a replayed last frame
//! after the stream reopens: nothing is dropped because the link was still
//! connecting when the frame landed.
//!
//! A refetch that fails after its own bounded retry is re-driven against the
//! same frame on a longer bounded backoff (see {@link FAILED_SETTLE_RETRY}):
//! a control-plane blip longer than one refetch cannot leave a badge on its
//! old value until the next frame or a reload.
import { atom, watch } from "ilha";

import type { AppDetail } from "../api-types";
import { appStateUrl, decodeAppState, feedKeys, liveFeed } from "../feeds";
import { invalidate, onSettled } from "../resource";
import { keys } from "../resources";
import type { AppRole } from "../roles";
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
    // The Deployments pause line reads this: a group must repaint when its
    // automatic budget runs out or a new sha resets it.
    env.autoDeploy,
  ]);

/** The app fields a badge or a gated button reads. `myRole` is included so a
 * user demoted while the page is open loses the admin buttons on the next
 * frame; the runner's state frame does not carry it yet, so an absent role
 * never counts as a change (see the report's owner-decision item). */
export interface FrameRole {
  readonly myRole?: AppRole | undefined;
}

/**
 * The hold a badge paints, coarse enough to be a change signal: the reason
 * plus the deadline to the second. `retryAt` is the same instant on every
 * frame up to a sub-millisecond jitter, so comparing the raw string would
 * refetch the detail every two seconds for nothing.
 */
const holdShown = (hold: RunnerAppState["app"]["fleetHold"]): string =>
  hold === null || hold === undefined
    ? ""
    : `${hold.hold}@${hold.retryAt.slice(0, 19)}`;

const appShown = (
  app: AppDetail["app"],
  frame: RunnerAppState["app"]
): boolean =>
  app.status !== frame.status ||
  app.desiredState !== frame.desiredState ||
  app.lastDeploySha !== frame.lastDeploySha ||
  app.lastError !== frame.lastError ||
  app.asleepSince !== frame.asleepSince ||
  // Same for the app's own pause line on the Deployments tab.
  JSON.stringify(app.autoDeploy) !== JSON.stringify(frame.autoDeploy) ||
  holdShown(app.fleetHold) !== holdShown(frame.fleetHold) ||
  app.name !== frame.name ||
  app.slug !== frame.slug ||
  app.subdomain !== frame.subdomain;

/** The cache keys `frame` proves stale. A cache never fetched is left alone:
 * its first fetch reads the runner itself. Exported for the unit tests. */
export const staleKeys = (
  appId: string,
  frame: RunnerAppState & FrameRole,
  detail?: AppDetail,
  environments?: readonly RunnerEnvironment[]
): string[] => {
  const stale: string[] = [];

  if (detail !== undefined) {
    const roleMoved =
      frame.myRole !== undefined && frame.myRole !== detail.myRole;

    if (roleMoved || appShown(detail.app, frame.app)) {
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

/** The caches one app page holds; `undefined` means "never fetched". */
export interface SyncCaches {
  readonly detail?: AppDetail | undefined;
  readonly environments?: readonly RunnerEnvironment[] | undefined;
}

/** One frame's plan: the keys to invalidate. Pure, so the drop/compare
 * rules have a fail-before test. */
export const syncPlan = (
  appId: string,
  frame: RunnerAppState & FrameRole,
  caches: SyncCaches
): string[] => staleKeys(appId, frame, caches.detail, caches.environments);

/** The latest frame per resource key: the runner's truth, newer than any
 * load that started before the frame arrived. A load that settles stale is
 * re-driven against it (see below), so one stale settle cannot wedge the
 * badge until the next change. */
const latestFrames = new Map<string, RunnerAppState & FrameRole>();

/** Frames already re-driven by a post-settle re-compare, per key: the store
 * still disagrees with one of these only while its control-plane read lags,
 * and refetching the same frame again would hot-loop instead of converging. */
const revalidatedFrames = new Map<string, string>();

/** The backoff for a refetch that failed every attempt: the fetch already
 * spent its own budget (four tries over about 7 s), so a longer blip is
 * re-driven here — 5 s doubling to a 30 s cap. One timer per key, ended by
 * an agreeing settle, a newer frame or unmount; a bad read that succeeds
 * stays governed by {@link revalidatedFrames}, not this timer. */
const FAILED_SETTLE_RETRY = { baseMs: 5000, capMs: 30_000 } as const;

/** One key's pending failure re-drive: the delay it was scheduled with, so
 * the next failure doubles it. */
interface FailedSettleRetry {
  readonly delayMs: number;
  timer: number | undefined;
}

/** Follow one app's state stream and invalidate whichever cache it proves
 * stale. Renders nothing, so its frames stay out of sessionStorage. */
const AppStateSync = ({ appId }: { appId: string }) => {
  const feed = liveFeed(
    feedKeys.appState(appId),
    appStateUrl(appId),
    decodeAppState,
    { persist: false }
  );

  const detailKey = keys.appDetail(appId);
  const environmentsKey = keys.environments(appId);

  // Per-instance, kept across ilha's re-renders (`atom.lazy` runs once): the
  // timer belongs to this stream's lifetime, so moving to another app cannot
  // leave one driving the previous app's keys.
  const settleRetries = atom.lazy(() => new Map<string, FailedSettleRetry>())();

  /** The frame `key` still disagrees with, or undefined once it agrees (or
   * when no frame has arrived). */
  const staleFrame = (
    key: string
  ): (RunnerAppState & FrameRole) | undefined => {
    const frame = latestFrames.get(key);

    if (frame === undefined) {
      return undefined;
    }

    const stale = syncPlan(appId, frame, {
      detail: readSwr<AppDetail>(keys.appDetail(appId)),
      environments: readSwr<RunnerEnvironment[]>(keys.environments(appId)),
    });

    return stale.includes(key) ? frame : undefined;
  };

  const cancelRetry = (key: string): void => {
    const retry = settleRetries.get(key);

    if (retry === undefined) {
      return;
    }

    window.clearTimeout(retry.timer);
    settleRetries.delete(key);
  };

  /** Re-invalidate `key` after a failed settle, one timer per key: the
   * refetch's own retry budget is spent, and a longer control-plane blip
   * must still converge without a new frame. */
  const scheduleRetry = (key: string): void => {
    if (staleFrame(key) === undefined) {
      cancelRetry(key);

      return;
    }

    const previous = settleRetries.get(key);

    if (previous !== undefined && previous.timer !== undefined) {
      return;
    }

    const delayMs =
      previous === undefined
        ? FAILED_SETTLE_RETRY.baseMs
        : Math.min(previous.delayMs * 2, FAILED_SETTLE_RETRY.capMs);

    const retry: FailedSettleRetry = { delayMs, timer: undefined };

    retry.timer = window.setTimeout(() => {
      retry.timer = undefined;

      // Unmounted, or a newer frame took over while this waited: the entry
      // is gone (or replaced), so this timer must do nothing.
      if (settleRetries.get(key) !== retry) {
        return;
      }

      if (staleFrame(key) === undefined) {
        settleRetries.delete(key);

        return;
      }

      invalidate(key);
    }, delayMs);

    settleRetries.set(key, retry);
  };

  watch(feed.state, (state) => {
    // Only a frame this stream delivered: `Cached` is a previous visit's
    // snapshot, older than the caches it would invalidate, and the other
    // states carry no new data. A replayed frame after a reopen is `Live`
    // again, so it is re-compared — never dropped because the link was
    // still connecting when it first arrived.
    if (state._tag !== "Live") {
      return;
    }

    // SAFETY: the frame decoder keeps every field it parses; `myRole` is an
    // additive runner field that may be absent until the runner sends it.
    const frame = state.value as RunnerAppState & FrameRole;

    latestFrames.set(detailKey, frame);
    latestFrames.set(environmentsKey, frame);

    // A newer frame is the newest truth: it takes over convergence below,
    // so any failure re-drive for the previous frame ends. If this frame's
    // own refetch also fails, its series restarts at the base delay.
    cancelRetry(detailKey);
    cancelRetry(environmentsKey);

    const stale = syncPlan(appId, frame, {
      detail: readSwr<AppDetail>(keys.appDetail(appId)),
      environments: readSwr<RunnerEnvironment[]>(keys.environments(appId)),
    });

    for (const key of stale) {
      revalidatedFrames.delete(key);
      invalidate(key);
    }
  });

  // After a load lands, re-check it against the latest frame: a fetch that
  // read while the runner was converging resolves older truth than a frame
  // that arrived mid-load, and nothing else would refetch it. At most one
  // extra fetch per settle, and only on disagreement — an agreeing stream
  // of frames never refetches. Watched through the settle hook, not a
  // reader, so the check itself starts no fetch.
  const recheck = (key: string): void => {
    // A settle that succeeded ends the failure series even when its read
    // still lags: the re-compare below is the one refetch this frame may
    // cost (see {@link revalidatedFrames}).
    cancelRetry(key);

    const frame = staleFrame(key);

    if (frame === undefined) {
      return;
    }

    const seen = JSON.stringify(frame);

    if (revalidatedFrames.get(key) === seen) {
      return;
    }

    revalidatedFrames.set(key, seen);
    invalidate(key);
  };

  watch.once(() => {
    const stopDetail = onSettled(detailKey, (outcome) => {
      if (outcome.ok) {
        recheck(detailKey);
      } else {
        scheduleRetry(detailKey);
      }
    });

    const stopEnvironments = onSettled(environmentsKey, (outcome) => {
      if (outcome.ok) {
        recheck(environmentsKey);
      } else {
        scheduleRetry(environmentsKey);
      }
    });

    return () => {
      stopDetail();
      stopEnvironments();

      for (const retry of settleRetries.values()) {
        window.clearTimeout(retry.timer);
      }

      settleRetries.clear();
    };
  });

  return null;
};

/** Mount point for the app the page shows. Its view is a one-item keyed
 * list so the layout's repaints reuse the sync (and its stream), while a
 * move to another app remounts it on that app's stream. */
export const AppStateSyncSlot = ({ appId }: { appId: string }) => [
  <AppStateSync key={appId} appId={appId} />,
];
