//! Overview's Sync from GitHub card: for apps created by a GitHub import,
//! when the caller holds the push role (a sync writes one commit and
//! deploys — exactly what push already allows). It shows the stored origin,
//! the ref, the last synced sha and the origin tip, and a button that force
//! syncs the tree with the origin. The button's steps are the one
//! `github-sync.machine` lifecycle; deploy state after a sync arrives
//! through the existing feeds (the Deployments tab's stream), never a new
//! EventSource here.

import { Link } from "@ilha/void";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { api } from "../api";
import { errorMessage } from "../errors";
import { resourceError, resourceValue } from "../resource";
import { appDetail, githubSync, invalidate, keys } from "../resources";
import type { GithubSyncOutcome, GithubSyncStatus } from "../runner";
import { Refresh } from "../ui/icons";
import { LoadError } from "../ui/load-error";
import { capabilities } from "./capabilities";
import {
  cancelConfirm,
  confirmSync,
  GithubSync,
  requestSync,
  syncFailed,
  syncSucceeded,
} from "./github-sync.machine";
import type { GithubSyncState } from "./github-sync.machine";

const SHA_CHARS = 7;

/** A sha shortened for the card ("never" before the first sync). */
const shortSha = (sha: string | null): string =>
  sha === null ? "never" : sha.slice(0, SHA_CHARS);

/** Per-instance card state, as reactive atoms (never a mutable box: box
 * writes do not repaint, so the confirmation never painted and the button
 * fired no request): the machine (null until the first click, when the
 * loaded status seeds `Idle`) and whether the component mounted — controls
 * stay disabled until mount, since the sync is a client fetch. */

/** Run one sync against the runner, folding its answer into the machine. A
 * 409 for an unconfirmed overwrite re-opens the confirmation (the tree
 * moved under the dialog); anything else succeeds or fails. */
const runSync = async (
  appId: string,
  machine: AtomHandle<GithubSyncState | null>,
  status: GithubSyncStatus,
  confirm: boolean
): Promise<void> => {
  machine.set(
    confirm
      ? confirmSync(status)
      : GithubSync.Syncing({ confirm: false, status })
  );

  try {
    const outcome = await api<GithubSyncOutcome>("/api/apps/syncFromGithub", {
      appId,
      confirm,
      expectedTip: status.currentTip ?? undefined,
    });

    machine.set(syncSucceeded(status, outcome));
    invalidate(keys.githubSync(appId));
  } catch (error) {
    machine.set(syncFailed(status, errorMessage(error)));
  }
};

const SyncButton = ({
  appId,
  machine,
  mounted,
  label,
  status,
}: {
  appId: string;
  machine: AtomHandle<GithubSyncState | null>;
  mounted: boolean;
  label: string;
  status: GithubSyncStatus;
}) => (
  <button
    class="btn btn-sm btn-primary"
    disabled={!mounted}
    onclick={() => {
      const next = requestSync(status);

      if (next._tag === "Syncing") {
        void runSync(appId, machine, status, false);
      } else {
        machine.set(next);
      }
    }}
    type="button"
  >
    <span class="inline-flex items-center gap-1">
      <Refresh />
      {label}
    </span>
  </button>
);

/** The card body by machine state: an exhaustive switch, so a new state
 * fails the build instead of painting nothing. */
const SyncBody = ({
  appId,
  machine,
  mounted,
  state,
}: {
  appId: string;
  machine: AtomHandle<GithubSyncState | null>;
  mounted: boolean;
  state: GithubSyncState;
}) => {
  switch (state._tag) {
    case "Idle": {
      return (
        <SyncButton
          appId={appId}
          machine={machine}
          mounted={mounted}
          label="Sync from GitHub"
          status={state.status}
        />
      );
    }

    case "Confirming": {
      return (
        <div class="flex flex-col gap-2">
          <p class="m-0 text-sm font-medium">
            {state.status.noiteCommits}{" "}
            {state.status.noiteCommits === 1 ? "Noite commit" : "Noite commits"}{" "}
            will be overwritten in the tree; they stay in history.
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-sm btn-warning"
              disabled={!mounted}
              onclick={() => {
                void runSync(appId, machine, state.status, true);
              }}
              type="button"
            >
              Sync anyway
            </button>
            <button
              class="btn btn-sm"
              disabled={!mounted}
              onclick={() => {
                machine.set(cancelConfirm(state.status));
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    case "Syncing": {
      return (
        <button class="btn btn-sm btn-primary" disabled type="button">
          <span class="inline-flex items-center gap-1">
            <Refresh />
            Syncing…
          </span>
        </button>
      );
    }

    case "Synced": {
      return (
        <div class="flex flex-col gap-2">
          <p class="m-0 text-sm font-medium">
            Synced to <code>{state.sha.slice(0, SHA_CHARS)}</code>
            {state.noiteOverwritten > 0
              ? ` (${state.noiteOverwritten} Noite ${state.noiteOverwritten === 1 ? "commit" : "commits"} overwritten in the tree)`
              : null}
          </p>
          <div class="flex flex-wrap gap-2">
            <Link class="btn btn-sm" href={`/apps/${appId}?t=deployments`}>
              View deploy
            </Link>
            <SyncButton
              appId={appId}
              machine={machine}
              mounted={mounted}
              label="Sync again"
              status={state.status}
            />
          </div>
        </div>
      );
    }

    case "UpToDate": {
      return (
        <div class="flex flex-col gap-2">
          <p class="m-0 text-sm">
            Up to date with the origin at{" "}
            <code>{state.sha.slice(0, SHA_CHARS)}</code>.
          </p>
          <div>
            <SyncButton
              appId={appId}
              machine={machine}
              mounted={mounted}
              label="Sync again"
              status={state.status}
            />
          </div>
        </div>
      );
    }

    case "Failed": {
      return (
        <div class="flex flex-col gap-2">
          <p class="text-error m-0 text-sm">{state.message}</p>
          <div>
            <SyncButton
              appId={appId}
              machine={machine}
              mounted={mounted}
              label="Retry sync"
              status={state.status}
            />
          </div>
        </div>
      );
    }

    default: {
      const _exhaustive: never = state;

      return _exhaustive;
    }
  }
};

/** Sync from GitHub, on the Overview for GitHub-imported apps when the
 * caller can push. Anything else (blank apps, templates without a stored
 * origin, viewers) paints nothing. */
export const GithubSyncCard = ({ appId }: { appId: string }) => {
  const info = resourceValue(appDetail(appId).state());

  if (!info || !info.app.imported || !capabilities(info.myRole).push) {
    return null;
  }

  return <GithubSyncIsland appId={appId} />;
};

/** The island owns the card's atoms and resource, every call unconditional
 * in one slot order. The outer gate must not call `githubSync` itself: a
 * `tracked` resource creates its atom on call, so calling it after the
 * gate's early return (or skipping it on some renders) scrambles ilha's
 * slots — the ILHA002 warning behind the dead button. A mutable
 * `atom.lazy` box is no substitute either: box writes do not repaint, so
 * the confirmation the click assigned never painted. */
const GithubSyncIsland = ({ appId }: { appId: string }) => {
  const machine = atom<GithubSyncState | null>(null);
  const mounted = atom(false);

  watch.once(() => {
    mounted.set(true);
  });

  const res = githubSync(appId);
  const snapshot = resourceValue(res.state());

  if (!snapshot) {
    if (res.state()._tag === "Loading") {
      return (
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 border">
          <div class="card-body gap-3">
            <h2 class="card-title m-0 text-base">Sync from GitHub</h2>
            <p class="m-0 text-sm opacity-70">Loading the origin…</p>
            <div>
              <button class="btn btn-sm btn-primary" disabled type="button">
                <span class="inline-flex items-center gap-1">
                  <Refresh />
                  Sync from GitHub
                </span>
              </button>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 border">
        <div class="card-body gap-3">
          <h2 class="card-title m-0 text-base">Sync from GitHub</h2>
          <LoadError
            error={resourceError(res.state())}
            label="Could not load the sync status"
          />
        </div>
      </section>
    );
  }

  if (!snapshot.imported || !snapshot.owner || !snapshot.repo) {
    return null;
  }

  const state = machine() ?? GithubSync.Idle({ status: snapshot });
  const status = snapshot;

  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 border">
      <div class="card-body gap-3">
        <h2 class="card-title m-0 text-base">Sync from GitHub</h2>
        <dl class="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-sm">
          <div class="flex gap-2">
            <dt class="opacity-70">Origin</dt>
            <dd class="m-0 font-mono">
              github.com/{status.owner}/{status.repo}
              {status.ref ? `@${status.ref}` : null}
              {status.path ? ` / ${status.path}` : null}
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="opacity-70">Last synced</dt>
            <dd class="m-0 font-mono">{shortSha(status.lastSyncSha)}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="opacity-70">Origin tip</dt>
            <dd class="m-0 font-mono">
              {status.originTip === null
                ? "unknown"
                : shortSha(status.originTip)}
            </dd>
          </div>
        </dl>
        <SyncBody
          appId={appId}
          machine={machine}
          mounted={mounted()}
          state={state}
        />
      </div>
    </section>
  );
};
