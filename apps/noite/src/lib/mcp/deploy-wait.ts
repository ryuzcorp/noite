/**
 * `wait_for_deploy`'s bounded long poll (the agent loop). The transport is
 * stateless HTTP — one POST, one answer, no SSE — so "wait for the deploy"
 * cannot be a subscription: it is one call that re-reads the real deploy row
 * until the row stops moving or its budget runs out, then answers either way.
 * An agent that got `Waiting` re-arms with the same arguments; the answer
 * carries the resume hint.
 *
 * ```text
 * read ─ terminal ─▶ Settled
 *   │
 *   └ not terminal ── budget left ──▶ sleep, read …
 *                    budget spent  ─▶ Waiting (row exists) | Missing (no row yet)
 * ```
 *
 * The clock is injected (`now`/`sleep`), so tests drive the budget with a fake
 * one and no test ever sleeps. The budget is capped below the transport's own
 * request bound (`MCP_TIMEOUT_MS` in `middleware/01-timeout`): this call
 * answers before the route's 504 can cut it.
 */
import { Data } from "effect";

import type { RunnerDeploy } from "../runner";
import type { DeployStatus } from "../runner-types/DeployStatus";

/** Every status a deploy row never leaves: a success, a failure, the
 * operator's stop and the sweep's timeout. */
export const TERMINAL_DEPLOY_STATUSES: readonly DeployStatus[] = [
  "success",
  "failed",
  "cancelled",
  "stalled",
];

/** Whether a deploy row is done, whatever ended it. */
export const isTerminalDeploy = (status: DeployStatus): boolean =>
  TERMINAL_DEPLOY_STATUSES.includes(status);

/** One wait's outcome, as one value. */
export type DeployWait = Data.TaggedEnum<{
  /** No row exists yet for what the caller waits for (a commit's deploy has
   * not been queued): re-arm, it may appear. */
  Missing: Record<never, never>;
  /** The row exists and still moves: re-arm with the same arguments. */
  Waiting: { readonly deploy: RunnerDeploy };
  /** The row reached a terminal status. */
  Settled: { readonly deploy: RunnerDeploy };
}>;

export const DeployWaits = Data.taggedEnum<DeployWait>();

/** The longest a single call waits. Two bounds apply and the shorter wins:
 * the MCP route's own `MCP_TIMEOUT_MS` (65 s), and the edge's progress-based
 * `write_idle` (1 m, `host/caddy.rs`) — a 60 s wait would sit exactly on that
 * edge and could be cut while healthy. 45 s leaves room for the read and the
 * response. */
export const MAX_WAIT_SECONDS = 45;

/** How often the poll re-reads the row. Two seconds: one `deploys.list` per
 * poll is the app's 20 newest rows (the fat query), so the interval is the one
 * lever this tool has on the cost of a long wait. */
export const WAIT_INTERVAL_MS = 2000;

/** Wait one interval on the real clock. `wait_for_deploy` passes this; a test
 * passes a fake one that advances its own clock instead of sleeping. */
export const realSleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- the only way to wait is a timer that resolves a callback; there is no ambient sleep primitive in the worker runtime.
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** What one poll needs, injected so the budget is testable without a clock. */
export interface WaitDeps {
  /** The row the caller waits for, or null when it does not exist yet. */
  readonly read: () => Promise<RunnerDeploy | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Poll `deps.read` until the row is terminal or `budgetMs` is spent, never
 * sleeping past the budget. The first read happens immediately, so a deploy
 * that already finished answers without a sleep. */
export const waitForDeploy = async (
  deps: WaitDeps,
  budgetMs: number
): Promise<DeployWait> => {
  let deploy = await deps.read();

  if (deploy !== null && isTerminalDeploy(deploy.status)) {
    return DeployWaits.Settled({ deploy });
  }

  const deadline = deps.now() + budgetMs;

  for (;;) {
    const left = deadline - deps.now();

    if (left <= 0) {
      break;
    }

    // Polling is the contract: each read must observe the row after the
    // previous wait, so these two awaits are sequential on purpose.
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
    await deps.sleep(Math.min(WAIT_INTERVAL_MS, left));
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
    deploy = await deps.read();

    if (deploy !== null && isTerminalDeploy(deploy.status)) {
      return DeployWaits.Settled({ deploy });
    }
  }

  return deploy === null
    ? DeployWaits.Missing()
    : DeployWaits.Waiting({ deploy });
};
