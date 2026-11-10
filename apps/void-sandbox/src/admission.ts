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

import type { AdmissionReason, StoredEntry } from "./admission-entry.ts";
import { applyEntry, decodeEntry, encodeEntry } from "./admission-entry.ts";
import type { ControllerEnv } from "./env.ts";
import { DEFAULT_MAX_CONCURRENT } from "./meta.ts";

/** Admission verdict. The controller maps these to Void's exact `VOID_SANDBOX_*` error strings. */
export type AdmissionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AdmissionReason };

/**
 * The stored table. Values keep the previous code's shape; `decodeEntry`
 * derives the tagged state and `encodeEntry` writes the same keys back.
 */
type Entries = Record<string, StoredEntry>;

const ENTRIES_KEY = "noite-sandbox-admission-v1";
const COMPLETIONS_KEY = "noite-sandbox-completions-v1";
const COMPLETION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETIONS = 4096;
const MAX_ID_LENGTH = 128;
const RECONCILE_INTERVAL_MS = 60_000;

/** Shortest admission name the controller accepts: 32 base64url characters, 192 bits. */
export const MIN_ADMISSION_NAME_LENGTH = 32;

/**
 * Parse `__VOID_SANDBOX_MAX_CONCURRENT`. A missing var takes the default
 * (the runner always renders it); a present-but-unreadable value fails
 * closed to `0` and admits nothing. Only a plain non-negative integer
 * counts — anything else, including trailing junk like `4x`, is unreadable.
 * `0` is a valid cap that admits nothing.
 */
export const readAdmissionCap = (raw?: string): number => {
  if (raw === undefined) {
    return DEFAULT_MAX_CONCURRENT;
  }

  const text = raw.trim();

  if (!/^\d+$/u.test(text)) {
    return 0;
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
      const entry = decodeEntry(entries[instanceId]);

      const decision = applyEntry(entry, {
        _tag: "Reserve",
        admitted: withinLimit(entries, instanceId, cap),
        // A timed-out reserve can finish after stop. Never admit that run again.
        fenced:
          entry === undefined
            ? await this.#hasCompletion(instanceId, generation)
            : false,
        generation,
        hasCapacity: Object.keys(entries).length < cap,
      });

      if (decision._tag !== "Admitted") {
        return {
          ok: false,
          reason: decision._tag === "Refused" ? decision.reason : "unavailable",
        };
      }

      if (decision.changed) {
        entries[instanceId] = encodeEntry(decision.entry);
        await this.#save(entries);
        // An entry that exists always has a scheduled sweep, so a crash
        // between a stop mark and its receipt can never leak capacity.
        await this.#ensureAlarm();
      }

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
      const entry = decodeEntry(entries[instanceId]);

      const decision = applyEntry(entry, {
        _tag: "Start",
        admitted: withinLimit(entries, instanceId, cap),
        at: Date.now(),
        generation,
      });

      if (decision._tag !== "Admitted") {
        return {
          ok: false,
          reason: decision._tag === "Refused" ? decision.reason : "unavailable",
        };
      }

      if (decision.changed) {
        entries[instanceId] = encodeEntry(decision.entry);
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
      const entry = decodeEntry(entries[instanceId]);

      const decision = applyEntry(entry, {
        _tag: "Heartbeat",
        admitted: withinLimit(entries, instanceId, cap),
        generation,
      });

      if (decision._tag !== "Admitted") {
        return {
          ok: false,
          reason: decision._tag === "Refused" ? decision.reason : "unavailable",
        };
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

    const at = Date.now();

    return await this.#serialize(async () => {
      const entries = await this.#load();
      const entry = decodeEntry(entries[instanceId]);
      const decision = applyEntry(entry, { _tag: "Stop", at, generation });

      if (decision._tag !== "Released") {
        return;
      }

      // Mark first: from this put on the generation refuses re-admission even
      // if the isolate dies before the receipt below commits. The sweep is
      // armed before the mark, so a crash from here on always has an alarm.
      if (decision.entry !== undefined) {
        entries[instanceId] = encodeEntry(decision.entry);
        await this.#ensureAlarm();
        await this.#save(entries);
      }

      await this.#recordCompletion(instanceId, generation);

      if (decision.entry !== undefined) {
        const { [instanceId]: _dropped, ...kept } = entries;
        void _dropped;
        await this.#save(kept);
      }
    });
  }

  /**
   * Finish stops torn by an isolate death between the mark and the receipt.
   * Never infers stop from age: only the controller's own lifecycle verifies
   * liveness and destroys denied containers. Re-arms itself while entries
   * remain, so a torn stop always has a future sweep to finish it.
   */
  override async alarm(): Promise<void> {
    await this.#serialize(async () => {
      const entries = await this.#load();
      const swept = new Set<string>();

      for (const [id, value] of Object.entries(entries)) {
        const entry = decodeEntry(value);

        if (entry?._tag === "Stopping") {
          // oxlint-disable-next-line eslint/no-await-in-loop -- completions share one storage key; the receipts must commit in order.
          await this.#recordCompletion(id, entry.generation);
          swept.add(id);
        }
      }

      if (swept.size > 0) {
        const kept: Entries = {};

        for (const [id, value] of Object.entries(entries)) {
          if (!swept.has(id)) {
            kept[id] = value;
          }
        }

        await this.#save(kept);
      }

      if (Object.keys(entries).length > swept.size) {
        await this.#ensureAlarm();
      }
    });
  }
}
