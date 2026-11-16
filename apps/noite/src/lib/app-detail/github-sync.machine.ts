//! The Sync from GitHub button's one state machine. A sync is one lifecycle,
//! never parallel flags: requesting it either asks for the overwrite
//! confirmation first (when the status counted Noite commits the sync would
//! overwrite in the tree) or goes straight to syncing, and the runner's
//! answer lands in exactly one terminal state.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Confirming: SyncRequested (noiteCommits > 0)
//!   Idle --> Syncing: SyncRequested (noiteCommits = 0)
//!   Confirming --> Syncing: Confirmed
//!   Confirming --> Idle: Cancelled
//!   Syncing --> Confirming: NeedsConfirm (409 overwrite — the tree moved under the dialog)
//!   Syncing --> Synced: Succeeded(synced)
//!   Syncing --> UpToDate: Succeeded(upToDate)
//!   Syncing --> Failed: Failed
//!   Failed --> Idle: SyncRequested
//!   Synced --> Idle: SyncRequested
//!   UpToDate --> Idle: SyncRequested
//! ```
//!
//! The runner's 409 for an unconfirmed overwrite carries the same "will be
//! overwritten" sentence its confirm dialog shows, so `isConfirmRequired`
//! recognizes it and the button re-opens the confirmation instead of
//! painting a failure.

import { Data } from "effect";

import type { GithubSyncOutcome, GithubSyncStatus } from "../runner";

/** The one lifecycle value the sync card holds: which step of a sync the
 * button is in, with the status the step was taken from. */
export type GithubSyncState = Data.TaggedEnum<{
  Idle: { readonly status: GithubSyncStatus };
  Confirming: { readonly status: GithubSyncStatus };
  Syncing: { readonly confirm: boolean; readonly status: GithubSyncStatus };
  Synced: {
    readonly noiteOverwritten: number;
    readonly originSha: string;
    readonly sha: string;
    readonly status: GithubSyncStatus;
  };
  UpToDate: { readonly sha: string; readonly status: GithubSyncStatus };
  Failed: { readonly message: string; readonly status: GithubSyncStatus };
}>;

export const GithubSync = Data.taggedEnum<GithubSyncState>();

/** A sync was requested from a settled state: the overwrite confirmation
 * comes first exactly when the status counted Noite commits the sync would
 * overwrite in the tree. */
export const requestSync = (status: GithubSyncStatus): GithubSyncState =>
  status.noiteCommits > 0
    ? GithubSync.Confirming({ status })
    : GithubSync.Syncing({ confirm: false, status });

/** The overwrite confirmation was accepted: sync with `confirm`. */
export const confirmSync = (status: GithubSyncStatus): GithubSyncState =>
  GithubSync.Syncing({ confirm: true, status });

/** The overwrite confirmation was dismissed: back to the idle button. */
export const cancelConfirm = (status: GithubSyncStatus): GithubSyncState =>
  GithubSync.Idle({ status });

/** The runner's answer: one new commit (`synced`) or a no-op (`upToDate`).
 * The status is refreshed by the caller (the last synced sha moved), so the
 * outcome keeps the request's status for context only. */
export const syncSucceeded = (
  status: GithubSyncStatus,
  outcome: GithubSyncOutcome
): GithubSyncState =>
  outcome.status === "synced"
    ? GithubSync.Synced({
        noiteOverwritten: outcome.noiteOverwritten,
        originSha: outcome.originSha,
        sha: outcome.sha,
        status,
      })
    : GithubSync.UpToDate({ sha: outcome.sha, status });

/** The runner refused with its unconfirmed-overwrite 409 after all (the
 * tree moved under the dialog): re-open the confirmation. Any other
 * failure — a tip that moved, a protected branch, an import still running —
 * is a terminal failure with the runner's message. */
export const syncFailed = (
  status: GithubSyncStatus,
  message: string
): GithubSyncState =>
  isConfirmRequired(message)
    ? GithubSync.Confirming({ status })
    : GithubSync.Failed({ message, status });

/** The runner's unconfirmed-overwrite refusal carries the same "will be
 * overwritten" sentence the confirm dialog shows. */
export const isConfirmRequired = (message: string): boolean =>
  message.includes("will be overwritten");
