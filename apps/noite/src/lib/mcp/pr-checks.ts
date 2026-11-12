/**
 * `get_pr`'s checks: what must be true before this pull request can merge, as
 * one list instead of three fields an agent has to combine itself. The runner
 * keeps no CI check-runs table, so the checks are the gates the product
 * actually enforces — mergeability, the approval rule, and the preview
 * environment's deploy of the head commit — derived from the detail the runner
 * already returned.
 *
 * Pure: the tool fetches the preview facts, this module reads them.
 */
import type { PrDetail, RunnerDeploy } from "../runner";
import { isTerminalDeploy } from "./deploy-wait";

/** One check's outcome. `skipped` means the gate does not apply (nothing to
 * check), not that it passed. */
export type CheckState = "failed" | "ok" | "pending" | "skipped";

/** What one check reports: its stable name, its state, and the sentence a
 * caller reads. */
export interface PrCheck {
  readonly detail: string;
  readonly name: "approvals" | "mergeability" | "preview";
  readonly state: CheckState;
}

/** The preview environment that tracks the PR's head branch, with the deploy
 * of the head commit (`null` while nothing deployed it yet). */
export interface PreviewFacts {
  readonly deploy: RunnerDeploy | null;
  readonly label: string;
  readonly lastError: string | null;
  readonly url: string;
}

/** Whether the PR's head commit deployed successfully to its preview: a
 * terminal failure reads `failed`, a live row `ok`, anything else `pending`. */
const previewCheck = (facts: PreviewFacts | null, headSha: string): PrCheck => {
  if (facts === null) {
    return {
      detail:
        "no preview environment tracks this branch (create_environment deploys one)",
      name: "preview",
      state: "skipped",
    };
  }

  if (facts.lastError !== null) {
    return { detail: facts.lastError, name: "preview", state: "failed" };
  }

  if (facts.deploy === null) {
    return {
      detail: `${facts.label}: nothing has deployed ${headSha.slice(0, 10)} yet`,
      name: "preview",
      state: "pending",
    };
  }

  if (facts.deploy.status === "success") {
    return {
      detail: `${facts.label} serves ${headSha.slice(0, 10)} at ${facts.url}`,
      name: "preview",
      state: "ok",
    };
  }

  if (isTerminalDeploy(facts.deploy.status)) {
    return {
      detail: `${facts.label}: deploy ${facts.deploy.id} is ${facts.deploy.status}`,
      name: "preview",
      state: "failed",
    };
  }

  return {
    detail: `${facts.label}: deploy ${facts.deploy.id} is ${facts.deploy.status}`,
    name: "preview",
    state: "pending",
  };
};

/** Every gate on this pull request, in the order a caller reads them. */
export const prChecks = (
  detail: PrDetail,
  preview: PreviewFacts | null
): readonly PrCheck[] => {
  const { compare } = detail;

  let mergeability: PrCheck;

  if (detail.mergeState === "mergeable") {
    mergeability = {
      detail: `merges cleanly into ${detail.pullRequest.base}`,
      name: "mergeability",
      state: "ok",
    };
  } else if (detail.mergeState === "blocked_approvals") {
    mergeability = {
      detail: "the diff merges cleanly; the approval rule is what blocks it",
      name: "mergeability",
      state: "ok",
    };
  } else if (detail.mergeState === "conflicts") {
    mergeability = {
      detail:
        compare === null
          ? "the head branch is gone"
          : `conflicts: ${compare.conflicts.join(", ")}`,
      name: "mergeability",
      state: "failed",
    };
  } else if (detail.mergeState === "head_missing") {
    mergeability = {
      detail: `the head branch ${detail.pullRequest.head} no longer exists`,
      name: "mergeability",
      state: "failed",
    };
  } else {
    mergeability = {
      detail: `this pull request is ${detail.mergeState}`,
      name: "mergeability",
      state: "skipped",
    };
  }

  const { approvals, requiredApprovals } = detail;

  const approvalsCheck: PrCheck =
    requiredApprovals === 0
      ? {
          detail: `no approvals required; ${approvals} recorded`,
          name: "approvals",
          state: "skipped",
        }
      : {
          detail: `${approvals} of ${requiredApprovals} required approval(s) counted`,
          name: "approvals",
          state: approvals >= requiredApprovals ? "ok" : "pending",
        };

  return [
    mergeability,
    approvalsCheck,
    previewCheck(preview, detail.pullRequest.headSha),
  ];
};
