//! The (viewer, branch) workspace preview: the hidden ref the runner deploys
//! it from, the environment label it carries, when it expires, and the
//! fingerprint of the changes a deploy snapshotted. Every rule here mirrors the
//! runner (`host/env_label.rs`, `service::environments::preview_ref`,
//! `RUNNER_ENVIRONMENT_TTL_H`), because the Preview panel has to name the
//! environment that belongs to *this* viewer without asking the runner again.

import type { RunnerEnvironment } from "../runner";
import type { WorkspaceChange } from "./workspace/types";

/** Longest DNS label the runner mints (`env_label::MAX_LABEL`). */
const MAX_LABEL = 40;

/** One ASCII alphanumeric — the only character a label keeps. */
const ASCII_ALNUM = /^[A-Za-z0-9]$/u;

/** `env_label::sanitize_label`: lowercased ASCII alphanumerics, every run of
 * anything else folded to a single `-`, cut to `MAX_LABEL`, no leading or
 * trailing `-`, and never empty (`env` is the floor). The user segment of a
 * preview ref is the viewer's id through this, so the panel can name the ref
 * the runner deployed from. */
export const sanitizedLabel = (raw: string): string => {
  let out = "";
  let dash = true;
  for (const char of raw) {
    if (ASCII_ALNUM.test(char)) {
      out += char.toLowerCase();
      dash = false;
      continue;
    }
    if (!dash) {
      out += "-";
      dash = true;
    }
  }
  out = out.slice(0, MAX_LABEL).replace(/-+$/u, "");
  return out === "" ? "env" : out;
};

/** `service::environments::preview_ref`: `refs/previews/<sanitized user>/<branch>`,
 * the hidden ref one viewer's uncommitted work on one branch is deployed from.
 * Never a branch, so it never shows in a branch list, a pull request or a
 * clone. */
export const workspacePreviewRef = (userId: string, branch: string): string =>
  `refs/previews/${sanitizedLabel(userId)}/${branch}`;

/** `RUNNER_ENVIRONMENT_TTL_H`: how long a workspace preview lives without a
 * deploy (0 disables the sweep, which only the operator can set). */
export const ENVIRONMENT_TTL_HOURS = 168;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** When a workspace preview expires: `RUNNER_ENVIRONMENT_TTL_H` after its last
 * deploy, or after its creation while nothing has deployed it. Null when the
 * row carries no readable stamp. */
export const environmentExpiresAt = (
  environment: Pick<RunnerEnvironment, "createdAt" | "lastDeployedAt">
): number | null => {
  const from = Date.parse(
    environment.lastDeployedAt ?? environment.createdAt ?? ""
  );
  return Number.isNaN(from) ? null : from + ENVIRONMENT_TTL_HOURS * HOUR_MS;
};

/** `expires in 7 days` — the workspace preview's remaining life, to the day
 * (whole days at first, `expires today` on the last one). Null when the row
 * carries no readable stamp. */
export const expiryLabel = (
  environment: Pick<RunnerEnvironment, "createdAt" | "lastDeployedAt">,
  now: number = Date.now()
): string | null => {
  const at = environmentExpiresAt(environment);
  if (at === null) {
    return null;
  }
  const days = Math.ceil((at - now) / DAY_MS);
  if (days <= 0) {
    return "expires soon";
  }
  return `expires in ${days} ${days === 1 ? "day" : "days"}`;
};

/** The digest's seed (djb2's) and its modulus: large enough that two change
 * sets do not collide by accident, small enough that `hash * 33 + code` stays
 * exact in a double. */
const DIGEST_SEED = 5381;
const DIGEST_MOD = 2_147_483_647;

/** A rolling digest of `text`, folded into `seed` — multiplicative rather than
 * bitwise (the house style bans bitwise operators), and cheap enough to run
 * over every changed file on every panel render. Only ever compared with
 * itself: a collision would cost a missing "unsaved changes" note, never a
 * wrong deploy. */
const digestOf = (text: string, seed: number): number => {
  let hash = seed;
  for (const char of text) {
    hash = (hash * 33 + (char.codePointAt(0) ?? 0)) % DIGEST_MOD;
  }
  return hash;
};

/** What a change set holds, as one short fingerprint: every path with its
 * kind, the committed path of a move and the content the snapshot writes — the
 * *current* side only (`after`, or a binary row's byte count), so a row whose
 * committed side is still being read fingerprints the same before and after
 * that read, and a derive's row order never matters. The Preview panel records
 * the fingerprint of the changes a deploy snapshotted and compares it with the
 * checkout's current one: equal means the framed snapshot holds every edit. */
export const changesFingerprint = (
  changes: readonly WorkspaceChange[]
): string => {
  // Sorted, so the digest is the change set's content and not its order.
  const ordered = [...changes].toSorted((a, b) => (a.path < b.path ? -1 : 1));
  let hash = DIGEST_SEED;
  for (const change of ordered) {
    const key = `${change.path}\u0000${change.kind}\u0000${change.movedFrom ?? ""}\u0000${change.binary === undefined ? "t" : "b"}${change.binary ?? ""}`;
    hash = digestOf(key, hash);
    if (change.binary === undefined) {
      hash = digestOf(change.after, hash);
    }
  }
  return hash.toString(16);
};
