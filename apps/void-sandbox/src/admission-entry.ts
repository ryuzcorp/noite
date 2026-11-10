/**
 * Admission entry machine: one row of the fleet's capacity table.
 *
 * The stored shape is unchanged (`{ generation, phase, startedAt?, stoppedAt? }`),
 * so an older controller can still read this table; the tagged state is
 * derived on read and the same keys are written back.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Reserved: Reserve (capacity free, not fenced)
 *   Reserved --> Reserved: Reserve (same generation)
 *   Reserved --> Running: Start
 *   Running --> Running: Start (idempotent) / Heartbeat
 *   Reserved --> Stopping: Stop
 *   Running --> Stopping: Stop
 *   Stopping --> [*]: Released
 * ```
 *
 * Invariants the type now carries:
 * - `Running` always has `startedAt`; `Reserved` never does. The old record
 *   could say `phase: "running"` without one, or `phase: "reserved"` with one.
 * - `Stopping` always has `stoppedAt`, and keeps the phase it stopped from so
 *   the encoded record matches what the previous code wrote.
 *
 * `applyEntry` is the only function that produces a next entry; the Durable
 * Object owns the table, the capacity cap and the completion records.
 */

export type AdmissionReason = "concurrency" | "unavailable";

export type AdmissionEntry =
  | { readonly _tag: "Reserved"; readonly generation: string }
  | {
      readonly _tag: "Running";
      readonly generation: string;
      readonly startedAt: number;
    }
  | {
      readonly _tag: "Stopping";
      readonly generation: string;
      readonly startedAt?: number;
      readonly stoppedAt: number;
    };

/** Exactly the value the previous code stored in `noite-sandbox-admission-v1`. */
export interface StoredEntry {
  readonly generation: string;
  readonly phase: "reserved" | "running";
  readonly startedAt?: number;
  readonly stoppedAt?: number;
}

export type AdmissionEvent =
  | {
      readonly _tag: "Reserve";
      /** The deterministic keep set admits this id. */
      readonly admitted: boolean;
      /** A completion record fences this generation out. */
      readonly fenced: boolean;
      readonly generation: string;
      /** The table has room for a new entry. */
      readonly hasCapacity: boolean;
    }
  | {
      readonly _tag: "Start";
      readonly admitted: boolean;
      readonly at: number;
      readonly generation: string;
    }
  | {
      readonly _tag: "Heartbeat";
      readonly admitted: boolean;
      readonly generation: string;
    }
  | { readonly _tag: "Stop"; readonly at: number; readonly generation: string };

export type AdmissionDecision =
  | {
      readonly _tag: "Admitted";
      /** False when the transition left the entry as it was. */
      readonly changed: boolean;
      readonly entry: AdmissionEntry;
    }
  | { readonly _tag: "Refused"; readonly reason: AdmissionReason }
  | {
      readonly _tag: "Released";
      /** The entry to drop from the table, or `undefined` when there was none. */
      readonly entry?: AdmissionEntry;
    };

/**
 * Derive the tagged entry. `phase` is not trusted (the old code could write
 * a phase that disagreed with `startedAt`); `startedAt`/`stoppedAt` decide.
 * An entry with no usable generation is undecodable: the caller keeps it in
 * the table (it still consumes capacity) and never mutates it.
 */
export const decodeEntry = (
  value?: StoredEntry
): AdmissionEntry | undefined => {
  if (value === undefined || value.generation.length === 0) {
    return undefined;
  }

  const { generation, startedAt, stoppedAt } = value;

  if (stoppedAt !== undefined) {
    return startedAt === undefined
      ? { _tag: "Stopping", generation, stoppedAt }
      : { _tag: "Stopping", generation, startedAt, stoppedAt };
  }

  return startedAt === undefined
    ? { _tag: "Reserved", generation }
    : { _tag: "Running", generation, startedAt };
};

/** The stored value for an entry, byte-compatible with the previous code. */
export const encodeEntry = (entry: AdmissionEntry): StoredEntry => {
  if (entry._tag === "Reserved") {
    return { generation: entry.generation, phase: "reserved" };
  }

  if (entry._tag === "Running") {
    return {
      generation: entry.generation,
      phase: "running",
      startedAt: entry.startedAt,
    };
  }

  return entry.startedAt === undefined
    ? {
        generation: entry.generation,
        phase: "reserved",
        stoppedAt: entry.stoppedAt,
      }
    : {
        generation: entry.generation,
        phase: "running",
        startedAt: entry.startedAt,
        stoppedAt: entry.stoppedAt,
      };
};

const admitted = (
  entry: AdmissionEntry,
  changed: boolean
): AdmissionDecision => ({ _tag: "Admitted", changed, entry });

const refused = (reason: AdmissionReason): AdmissionDecision => ({
  _tag: "Refused",
  reason,
});

const stop = (
  entry: AdmissionEntry | undefined,
  generation: string,
  at: number
): AdmissionDecision => {
  if (entry === undefined || entry.generation !== generation) {
    // A stop may overtake its reserve: nothing to drop, but the completion
    // record still fences this generation out.
    return { _tag: "Released" };
  }

  if (entry._tag === "Stopping") {
    return { _tag: "Released", entry };
  }

  return {
    _tag: "Released",
    entry:
      entry._tag === "Running"
        ? {
            _tag: "Stopping",
            generation: entry.generation,
            startedAt: entry.startedAt,
            stoppedAt: at,
          }
        : { _tag: "Stopping", generation: entry.generation, stoppedAt: at },
  };
};

/**
 * The one transition function for an admission entry. Pure: capacity,
 * fencing and the clock arrive as event fields.
 */
export const applyEntry = (
  entry: AdmissionEntry | undefined,
  event: AdmissionEvent
): AdmissionDecision => {
  if (event._tag === "Stop") {
    return stop(entry, event.generation, event.at);
  }

  if (entry === undefined) {
    if (event._tag !== "Reserve") {
      return refused("unavailable");
    }

    if (event.fenced) {
      // A timed-out reserve can finish after its stop; never admit it again.
      return refused("unavailable");
    }

    return event.hasCapacity
      ? admitted({ _tag: "Reserved", generation: event.generation }, true)
      : refused("concurrency");
  }

  if (entry.generation !== event.generation || entry._tag === "Stopping") {
    return refused("unavailable");
  }

  if (!event.admitted) {
    return refused("concurrency");
  }

  if (event._tag === "Start") {
    return entry._tag === "Running"
      ? admitted(entry, false)
      : admitted(
          {
            _tag: "Running",
            generation: entry.generation,
            startedAt: event.at,
          },
          true
        );
  }

  return admitted(entry, false);
};
