//! Sync from GitHub: the tiny button next to the app's status line in the
//! header, for apps created by a GitHub import when the caller holds the
//! push role (a sync writes one commit and deploys — exactly what push
//! already allows). A click syncs straight when the tree is clean, or opens
//! the overwrite confirmation (a real modal dialog) when Noite-side commits
//! would be overwritten in the tree. The dialog also carries the origin
//! facts (origin, last synced, origin tip) and the result (`Synced to
//! <sha>`, up-to-date, or the runner's refusal). The button's steps are the
//! one `github-sync.machine` lifecycle; deploy state after a sync arrives
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
import { Dialog } from "../ui/dialog";
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

/** A sha shortened for the button ("never" before the first sync). */
const shortSha = (sha: string | null): string =>
  sha === null ? "never" : sha.slice(0, SHA_CHARS);

/** The tooltip on the tiny button: where a sync would go from. */
const syncTitle = (status: GithubSyncStatus): string =>
  `Origin github.com/${status.owner}/${status.repo}${status.ref ? `@${status.ref}` : ""} · last synced ${shortSha(status.lastSyncSha)} · origin tip ${status.originTip === null ? "unknown" : shortSha(status.originTip)}`;

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
  label,
  mounted,
  onSync,
}: {
  label: string;
  mounted: boolean;
  onSync: () => void;
}) => (
  <button
    class="btn btn-sm btn-primary"
    disabled={!mounted}
    onclick={onSync}
    type="button"
  >
    <span class="inline-flex items-center gap-1">
      <Refresh />
      {label}
    </span>
  </button>
);

/** The origin facts the dialog carries: which origin, what the app last
 * synced to, and where the origin's tip is now. */
const SyncFacts = ({ status }: { status: GithubSyncStatus }) => (
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
        {status.originTip === null ? "unknown" : shortSha(status.originTip)}
      </dd>
    </div>
  </dl>
);

/** The dialog body by machine state: an exhaustive switch, so a new state
 * fails the build instead of painting nothing. */
const SyncBody = ({
  appId,
  idleLabel,
  machine,
  mounted,
  onCancel,
  state,
  syncNow,
}: {
  appId: string;
  idleLabel: string;
  machine: AtomHandle<GithubSyncState | null>;
  mounted: boolean;
  onCancel: () => void;
  state: GithubSyncState;
  syncNow: () => void;
}) => {
  switch (state._tag) {
    case "Idle": {
      return (
        <SyncButton label={idleLabel} mounted={mounted} onSync={syncNow} />
      );
    }

    case "Confirming": {
      return (
        <div class="flex flex-col gap-2">
          <p class="m-0 text-sm font-medium">
            {state.status.noiteCommits}{" "}
            {state.status.noiteCommits === 1 ? (
              <>
                Noite commit will be overwritten in the tree; it stays in
                history.
              </>
            ) : (
              <>
                Noite commits will be overwritten in the tree; they stay in
                history.
              </>
            )}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-sm btn-warning"
              disabled={!mounted}
              onclick={() => {
                // The confirmation names the tip it displayed: send that
                // tip, never a refetched one, so a branch that moved under
                // the dialog fails the runner's compare-and-set instead of
                // silently overwriting the new commit.
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
                onCancel();
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
            <SyncButton label="Sync again" mounted={mounted} onSync={syncNow} />
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
            <SyncButton label="Sync again" mounted={mounted} onSync={syncNow} />
          </div>
        </div>
      );
    }

    case "Failed": {
      return (
        <div class="flex flex-col gap-2">
          <p class="text-error m-0 text-sm">{state.message}</p>
          <div>
            <SyncButton label="Retry sync" mounted={mounted} onSync={syncNow} />
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

/** The dialog the tiny button opens: the origin facts plus the machine body.
 * The machine survives closes, so reopening re-reads the last result; every
 * button click still decides fresh from the latest status (a sync
 * invalidates it, so the facts never go stale). */
const SyncDialog = ({
  appId,
  machine,
  mounted,
  onCancel,
  open,
  resFailed,
  snapshot,
  syncError,
  syncNow,
}: {
  appId: string;
  machine: AtomHandle<GithubSyncState | null>;
  mounted: boolean;
  onCancel: () => void;
  open: AtomHandle<boolean>;
  resFailed: boolean;
  snapshot: GithubSyncStatus | undefined;
  syncError: unknown;
  syncNow: () => void;
}) => {
  const failed = snapshot === undefined && resFailed;
  const loading = snapshot === undefined && !resFailed;

  const state =
    machine() ?? (snapshot ? GithubSync.Idle({ status: snapshot }) : null);

  return (
    <Dialog open={open} class="modal" labelledBy="github-sync-title">
      <div class="modal-box bg-base-100 dark:bg-base-200">
        <h2 id="github-sync-title" class="m-0 text-lg font-bold">
          Sync from GitHub
        </h2>
        <div class="flex flex-col gap-3 py-4">
          {snapshot ? <SyncFacts status={snapshot} /> : null}
          {loading ? (
            <p class="m-0 text-sm opacity-70">Loading the origin…</p>
          ) : null}
          {failed ? (
            <LoadError
              error={syncError}
              label="Could not load the sync status"
            />
          ) : null}
          {state ? (
            <SyncBody
              appId={appId}
              idleLabel="Sync now"
              machine={machine}
              mounted={mounted}
              onCancel={onCancel}
              state={state}
              syncNow={syncNow}
            />
          ) : null}
        </div>
        {/* One dismiss action only: the overwrite confirmation dismisses
            with Cancel next to "Sync anyway"; every other state closes
            here. */}
        {state?._tag === "Confirming" ? null : (
          <div class="modal-action m-0">
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                open.set(false);
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
};

/** The island owns the button's atoms and the sync-status resource, every
 * call unconditional in one slot order. The atoms are reactive (never a
 * mutable box: box writes do not repaint, so the confirmation the click
 * assigned never painted). The outer gate must not call `githubSync`
 * itself: a `tracked` resource creates its atom on call, so calling it
 * after the gate's early return (or skipping it on some renders) scrambles
 * ilha's slots — the ILHA002 warning behind the dead button. */
const GithubSyncIsland = ({ appId }: { appId: string }) => {
  const machine = atom<GithubSyncState | null>(null);
  const mounted = atom(false);
  const open = atom(false);

  watch.once(() => {
    mounted.set(true);
  });

  const res = githubSync(appId);
  const snapshot = resourceValue(res.state());
  const resFailed = res.state()._tag === "Failed";

  /** Sync from the latest status, never the snapshot the dialog opened with:
   * a refetch first, so a click after the tree moved (or Retry after a
   * tip-moved refusal) decides from the moved tree instead of looping on
   * the stale one. The dialog opens immediately; the decision lands when
   * the refetch does. The machine moves to Syncing synchronously first, so
   * a second click while the refetch runs is refused instead of firing a
   * second request. */
  const syncNow = (): void => {
    if (machine()?._tag === "Syncing") {
      return;
    }

    const cached = resourceValue(res.state());

    if (cached) {
      machine.set(GithubSync.Syncing({ confirm: false, status: cached }));
    }

    void (async () => {
      let status: GithubSyncStatus | undefined;

      try {
        status = await res.refetch();
      } catch {
        status = undefined;
      }

      const current = status ?? resourceValue(res.state());

      if (!current) {
        machine.set(null);

        return;
      }

      const next = requestSync(current);

      if (next._tag !== "Syncing") {
        machine.set(next);

        return;
      }

      void runSync(appId, machine, current, false);
    })();
  };

  /** One click does the whole decision: a clean tree syncs straight (the
   * dialog opens on the progress), a tree with Noite-side commits opens on
   * the overwrite confirmation instead. */
  const start = () => {
    open.set(true);
    syncNow();
  };

  /** Cancel dismisses the dialog, back to a fresh Idle. */
  const onCancel = () => {
    open.set(false);
    machine.set(null);
  };

  let title = "Loading the origin…";

  if (snapshot) {
    title = syncTitle(snapshot);
  } else if (resFailed) {
    title =
      "Sync from GitHub: the origin status failed to load — open for the error";
  }

  return (
    <>
      <button
        type="button"
        class="btn btn-xs"
        disabled={
          !mounted() ||
          res.state()._tag === "Loading" ||
          machine()?._tag === "Syncing"
        }
        title={title}
        onclick={start}
      >
        <span class="inline-flex items-center gap-1">
          <Refresh />
          Sync from GitHub
        </span>
      </button>
      <SyncDialog
        appId={appId}
        machine={machine}
        mounted={mounted()}
        onCancel={onCancel}
        open={open}
        resFailed={resFailed}
        snapshot={snapshot}
        syncError={resourceError(res.state())}
        syncNow={syncNow}
      />
    </>
  );
};

/** Sync from GitHub, as the tiny header button next to the app's status
 * line. Anything else (blank apps, templates without a stored origin,
 * viewers) paints nothing. */
export const GithubSyncButton = ({ appId }: { appId: string }) => {
  const info = resourceValue(appDetail(appId).state());

  if (!info || !info.app.imported || !capabilities(info.myRole).push) {
    return null;
  }

  return <GithubSyncIsland appId={appId} />;
};
