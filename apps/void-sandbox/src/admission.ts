/**
 * Fleet-local sandbox admission: the Noite replacement for Void's
 * `__VOID_SANDBOX_CONTROL` service (see SPEC.md "Void sandbox controller").
 *
 * One instance per fleet, bound as `__VOID_SANDBOX_ADMISSION` and never
 * exposed to the app, addressed by the runner-minted secret name in
 * `__VOID_SANDBOX_ADMISSION_NAME` (celld named ids are computable from a
 * public name, so a fixed name would be a public address). The interface and
 * the fencing semantics follow Void's `sandbox-concurrency-counter.ts` (MIT
 * License, Copyright Cloudflare — see NOTICE): a stopped generation is never
 * re-admitted, and `stopped` always succeeds so teardown works after cap
 * changes. Dropped as meaningless on a single-install fleet: metering,
 * attribution, plan limits, runtime budgets, suspension, drain, and the
 * deploy-revocation path.
 *
 * Capacity rule: at most `cap` live entries, counted over every stored entry
 * (a stop still consumes capacity until its receipt commits). A cap shrink
 * deterministically keeps the lowest ids; `0` admits nothing.
 */
/* oxlint-disable anti-slop/no-known-value-widening -- RPC inputs arrive untyped at runtime; `validId` re-establishes the string contract at every entry point. */
import { DurableObject } from "cloudflare:workers";

import type { ControllerEnv } from "./env.ts";
import { DEFAULT_MAX_CONCURRENT } from "./meta.ts";

/** Admission verdict. The controller maps these to Void's exact `VOID_SANDBOX_*` error strings. */
export type AdmissionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "concurrency" | "unavailable" };

interface Entry {
  readonly generation: string;
  readonly phase: "reserved" | "running";
  readonly startedAt?: number;
  /** Set before the stop receipt commits; the alarm finishes a torn stop. */
  readonly stoppedAt?: number;
}

type Entries = Record<string, Entry>;

const ENTRIES_KEY = "noite-sandbox-admission-v1";
const COMPLETIONS_KEY = "noite-sandbox-completions-v1";
const COMPLETION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETIONS = 4096;
const MAX_ID_LENGTH = 128;
const RECONCILE_INTERVAL_MS = 60_000;

/** Shortest admission name the controller accepts: 32 base64url characters, 192 bits. */
export const MIN_ADMISSION_NAME_LENGTH = 32;

/**
 * Parse `__VOID_SANDBOX_MAX_CONCURRENT`. Only a plain non-negative integer
 * counts; anything else (including trailing junk like `4x`) falls back to
 * the default. `0` is a valid cap that admits nothing.
 */
export const readAdmissionCap = (raw?: string): number => {
  if (raw === undefined) {
    return DEFAULT_MAX_CONCURRENT;
  }

  const text = raw.trim();

  if (!/^\d+$/u.test(text)) {
    return DEFAULT_MAX_CONCURRENT;
  }

  return Math.trunc(Number(text));
};

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

const byCompletedAt = (
  left: readonly [string, number],
  right: readonly [string, number]
): number => left[1] - right[1];

const completionKey = (id: string, generation: string): string =>
  JSON.stringify([id, generation]);

/**
 * Deterministic keep set under a cap shrink: the lowest ids survive.
 * Stopping entries still count until their receipt commits.
 */
const withinLimit = (entries: Entries, id: string, cap: number): boolean =>
  Object.keys(entries).toSorted().indexOf(id) < cap;

const settleTail = (): void => {
  // The tail only sequences; each waiter already owns its own outcome.
};

export class NoiteSandboxAdmission extends DurableObject<ControllerEnv> {
  #entries: Entries | null = null;
  #tail: Promise<void> = Promise.resolve();

  /**
   * Hold application ordering across the awaits below: storage I/O releases
   * the input gate, and without the queue a delayed heartbeat could resurrect
   * a released run or two reserves could over-admit.
   */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    // oxlint-disable-next-line promise/prefer-await-to-then -- the queue links continuations; awaiting here would serialize the caller instead of the work.
    const result = this.#tail.then(operation);
    // oxlint-disable-next-line promise/prefer-await-to-then -- see above: the tail must advance without blocking this call.
    this.#tail = result.then(settleTail, settleTail);

    return result;
  }

  async #load(): Promise<Entries> {
    this.#entries ??= (await this.ctx.storage.get<Entries>(ENTRIES_KEY)) ?? {};

    return { ...this.#entries };
  }

  async #save(entries: Entries): Promise<void> {
    await this.ctx.storage.put(ENTRIES_KEY, entries);
    this.#entries = { ...entries };
  }

  #cap(): number {
    return readAdmissionCap(this.env.__VOID_SANDBOX_MAX_CONCURRENT);
  }

  async #ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  /** Completions inside retention, oldest first, bounded. */
  async #completions(): Promise<Record<string, number>> {
    const stored =
      (await this.ctx.storage.get<Record<string, number>>(COMPLETIONS_KEY)) ??
      {};

    const cutoff = Date.now() - COMPLETION_RETENTION_MS;

    return Object.fromEntries(
      Object.entries(stored)
        .filter(([, completedAt]) => completedAt >= cutoff)
        .toSorted(byCompletedAt)
        .slice(-MAX_COMPLETIONS)
    );
  }

  async #hasCompletion(id: string, generation: string): Promise<boolean> {
    return completionKey(id, generation) in (await this.#completions());
  }

  async #recordCompletion(id: string, generation: string): Promise<void> {
    const completions = await this.#completions();
    completions[completionKey(id, generation)] = Date.now();
    await this.ctx.storage.put(
      COMPLETIONS_KEY,
      Object.fromEntries(
        Object.entries(completions)
          .toSorted(byCompletedAt)
          .slice(-MAX_COMPLETIONS)
      )
    );
  }

  async reserve(
    instanceId: string,
    generation: string
  ): Promise<AdmissionResult> {
    if (!validId(instanceId) || !validId(generation)) {
      return { ok: false, reason: "unavailable" };
    }

    return await this.#serialize(async () => {
      const cap = this.#cap();
      const entries = await this.#load();
      const current = entries[instanceId];

      if (current !== undefined) {
        if (
          current.generation !== generation ||
          current.stoppedAt !== undefined
        ) {
          return { ok: false, reason: "unavailable" };
        }

        return withinLimit(entries, instanceId, cap)
          ? { ok: true }
          : { ok: false, reason: "concurrency" };
      }

      // A timed-out reserve can finish after stop. Never admit that run again.
      if (await this.#hasCompletion(instanceId, generation)) {
        return { ok: false, reason: "unavailable" };
      }

      if (Object.keys(entries).length >= cap) {
        return { ok: false, reason: "concurrency" };
      }

      entries[instanceId] = { generation, phase: "reserved" };
      await this.#save(entries);

      return { ok: true };
    });
  }

  async started(
    instanceId: string,
    generation: string
  ): Promise<AdmissionResult> {
    if (!validId(instanceId) || !validId(generation)) {
      return { ok: false, reason: "unavailable" };
    }

    return await this.#serialize(async () => {
      const cap = this.#cap();
      const entries = await this.#load();
      const current = entries[instanceId];

      if (
        current === undefined ||
        current.generation !== generation ||
        current.stoppedAt !== undefined
      ) {
        return { ok: false, reason: "unavailable" };
      }

      if (!withinLimit(entries, instanceId, cap)) {
        return { ok: false, reason: "concurrency" };
      }

      if (current.startedAt === undefined) {
        entries[instanceId] = {
          ...current,
          phase: "running",
          startedAt: Date.now(),
        };
        await this.#save(entries);
      }

      return { ok: true };
    });
  }

  async heartbeat(
    instanceId: string,
    generation: string
  ): Promise<AdmissionResult> {
    if (!validId(instanceId) || !validId(generation)) {
      return { ok: false, reason: "unavailable" };
    }

    return await this.#serialize(async () => {
      const cap = this.#cap();
      const entries = await this.#load();
      const current = entries[instanceId];

      if (
        current === undefined ||
        current.generation !== generation ||
        current.stoppedAt !== undefined
      ) {
        return { ok: false, reason: "unavailable" };
      }

      if (!withinLimit(entries, instanceId, cap)) {
        return { ok: false, reason: "concurrency" };
      }

      return { ok: true };
    });
  }

  /**
   * Release capacity. Always succeeds for well-formed ids — including unknown
   * ids, wrong generations, and full or zeroed caps — so teardown works after
   * cap changes. A stop that overtakes its reserve still fences that
   * generation out via the completion record.
   */
  async stopped(instanceId: string, generation: string): Promise<void> {
    if (!validId(instanceId) || !validId(generation)) {
      throw new Error("Invalid Sandbox admission identity.");
    }

    const stoppedAt = Date.now();

    return await this.#serialize(async () => {
      const entries = await this.#load();
      const current = entries[instanceId];

      if (current === undefined || current.generation !== generation) {
        // Stop may overtake a reserve whose transport timed out.
        await this.#recordCompletion(instanceId, generation);

        return;
      }

      // Mark first: from this put on the generation refuses re-admission even
      // if the isolate dies before the receipt below commits.
      if (current.stoppedAt === undefined) {
        entries[instanceId] = { ...current, stoppedAt };
        await this.#save(entries);
      }

      await this.#ensureAlarm();
      // Receipt precedes capacity release; any partial failure is safe for the
      // alarm to retry.
      await this.#recordCompletion(instanceId, generation);
      const { [instanceId]: _dropped, ...kept } = entries;
      void _dropped;
      await this.#save(kept);
    });
  }

  /**
   * Finish stops torn by an isolate death between the mark and the receipt.
   * Never infers stop from age: only the controller's own lifecycle verifies
   * liveness and destroys denied containers.
   */
  override async alarm(): Promise<void> {
    await this.#serialize(async () => {
      const entries = await this.#load();
      const swept = new Set<string>();

      for (const [id, entry] of Object.entries(entries)) {
        if (entry.stoppedAt !== undefined) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- completions share one storage key; the receipts must commit in order.
          await this.#recordCompletion(id, entry.generation);
          swept.add(id);
        }
      }

      if (swept.size > 0) {
        const kept: Entries = {};

        for (const [id, entry] of Object.entries(entries)) {
          if (!swept.has(id)) {
            kept[id] = entry;
          }
        }

        await this.#save(kept);
      }
    });
  }
}
