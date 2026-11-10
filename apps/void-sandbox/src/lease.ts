/**
 * Sandbox controller lease machine: the durable `__voidSandboxLease` record
 * and the container's platform-owned lifecycle.
 *
 * States (one per durable shape, plus the cell's in-memory completion):
 *
 * | state      | durable record                                  |
 * | ---------- | ----------------------------------------------- |
 * | `Absent`   | none                                            |
 * | `Pending`  | `{ generation, phase: "pending" }`              |
 * | `Running`  | `{ generation, phase: "running" }`              |
 * | `Stopping` | `{ generation, phase: "stopped" }`, release due |
 * | `Stopped`  | transient: the release effects ran and cleared  |
 *
 * `Stopping` means "the durable stop mark exists but the admission slot may
 * still be held"; it is what a crash mid-teardown reads back, so `Release`
 * finishes it. The container's `running` flag and the base class's `starting`
 * flag are transition *inputs* (`LeaseFacts`), never parallel state.
 *
 * Legal transitions (`stepLease` is the only writer):
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Absent
 *   Absent --> Pending: Start
 *   Pending --> Pending: Start (supersede)
 *   Running --> Running: Start (heartbeat, container live)
 *   Running --> Pending: Start (supersede)
 *   Pending --> Running: Started
 *   Running --> Running: Started (re-arm)
 *   Running --> Running: Use / Recover (heartbeat)
 *   Pending --> Stopping: Release / Recover (not starting)
 *   Running --> Stopping: Release / Recover (container gone)
 *   Stopping --> Stopped: Release / Recover
 *   Stopping --> Pending: Start
 *   Stopped --> Pending: Start
 *   Stopped --> Absent: Clear ran
 * ```
 *
 * `Started` and `Use` in any other state are refused; `Release` is refused
 * while the container is still running (releasing the admission slot then
 * would hand a live container's capacity to someone else).
 *
 * Every transition returns the effects the controller must run, in order;
 * storage writes are one of those effects, so a failed effect leaves the
 * durable record as the recovery point for the next alarm tick.
 */

/** Closed lease type; every branch mirrors a durable shape the old code wrote. */
export type Lease =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Pending"; readonly generation: string }
  | { readonly _tag: "Running"; readonly generation: string }
  | { readonly _tag: "Stopping"; readonly generation: string }
  | { readonly _tag: "Stopped"; readonly generation: string };

/** Any lease that names a generation (everything except `Absent`). */
export type GenerationedLease = Exclude<Lease, { readonly _tag: "Absent" }>;

/** Exactly the value `__voidSandboxLease` holds — unchanged from the previous code. */
export interface StoredLease {
  readonly generation: string;
  readonly phase: "pending" | "running" | "stopped";
}

export type LeaseEvent =
  | { readonly _tag: "Start"; readonly generation: string }
  | { readonly _tag: "Started" }
  | { readonly _tag: "Use" }
  | { readonly _tag: "Recover" }
  | { readonly _tag: "Release" };

export interface LeaseFacts {
  readonly container: "running" | "stopped";
  readonly starting: boolean;
}

export type AdmissionMethod = "reserve" | "started" | "heartbeat";

export type LeaseEffect =
  /** Raw `container.destroy()`: used inside `beforeStart`, where the base `destroy()` would bump the start epoch. */
  | { readonly _tag: "Kill" }
  /** Base `destroy()`: container teardown, setup reset, then the `stopped()` hook (which releases admission). */
  | { readonly _tag: "Destroy" }
  | {
      readonly _tag: "Admit";
      readonly generation: string;
      readonly method: AdmissionMethod;
    }
  | { readonly _tag: "Persist"; readonly lease: Lease }
  /** Compare-and-set the durable stop mark; a newer lease is left alone. */
  | { readonly _tag: "MarkStopping"; readonly generation: string }
  /** Compare-and-set `pending` → `running`; a newer lease is left alone. */
  | { readonly _tag: "MarkRunning"; readonly generation: string }
  | { readonly _tag: "ReleaseAdmission"; readonly generation: string }
  /** Compare-and-clear: only clears when the record still names `generation`. */
  | { readonly _tag: "Clear"; readonly generation: string }
  /** Run the full release transition (serialized, idempotent). */
  | { readonly _tag: "ReleaseNow" }
  | { readonly _tag: "Arm" }
  | { readonly _tag: "Touch" };

export type LeaseDecision =
  | {
      readonly _tag: "Next";
      readonly effects: readonly LeaseEffect[];
      readonly lease: Lease;
    }
  | { readonly _tag: "Refused"; readonly effects: readonly LeaseEffect[] };

/**
 * Derive the tagged lease from the stored value. An unknown phase or a
 * malformed record becomes `Stopping` when it names a generation: the safe
 * response is to release (never adopt) whatever it described. A record with
 * no usable generation is `Absent`, because there is nothing to release.
 */
export const decodeLease = (value?: StoredLease): Lease => {
  if (value === undefined || value.generation.length === 0) {
    return { _tag: "Absent" };
  }

  if (value.phase === "pending") {
    return { _tag: "Pending", generation: value.generation };
  }

  if (value.phase === "running") {
    return { _tag: "Running", generation: value.generation };
  }

  return { _tag: "Stopping", generation: value.generation };
};

/**
 * The value to store for a lease, or `null` to delete the key. `Stopping`
 * and `Stopped` both write `phase: "stopped"`: the mark is written before the
 * admission receipt, so any crash window reads back as `Stopping`.
 */
export const encodeLease = (lease: Lease): StoredLease | null => {
  if (lease._tag === "Absent") {
    return null;
  }

  if (lease._tag === "Pending") {
    return { generation: lease.generation, phase: "pending" };
  }

  if (lease._tag === "Running") {
    return { generation: lease.generation, phase: "running" };
  }

  return { generation: lease.generation, phase: "stopped" };
};

const next = (
  lease: Lease,
  effects: readonly LeaseEffect[]
): LeaseDecision => ({ _tag: "Next", effects, lease });

const refused = (effects: readonly LeaseEffect[]): LeaseDecision => ({
  _tag: "Refused",
  effects,
});

const admit = (method: AdmissionMethod, generation: string): LeaseEffect => ({
  _tag: "Admit",
  generation,
  method,
});

/** Teardown shared by `Release`, `Recover` and a superseding `Start`. */
const releaseEffects = (
  lease: GenerationedLease,
  marked: boolean
): readonly LeaseEffect[] => {
  const effects: LeaseEffect[] = [];

  if (!marked) {
    effects.push({ _tag: "MarkStopping", generation: lease.generation });
  }

  effects.push(
    { _tag: "Arm" },
    { _tag: "ReleaseAdmission", generation: lease.generation },
    { _tag: "Clear", generation: lease.generation }
  );

  return effects;
};

const start = (
  lease: Lease,
  generation: string,
  facts: LeaseFacts
): LeaseDecision => {
  if (lease._tag === "Running" && facts.container === "running") {
    return next(lease, [admit("heartbeat", lease.generation), { _tag: "Arm" }]);
  }

  const effects: LeaseEffect[] = [];

  if (facts.container === "running") {
    // Never adopt, or leave, a container the durable record does not own.
    effects.push({ _tag: "Kill" });
  }

  if (lease._tag === "Pending" || lease._tag === "Running") {
    effects.push(...releaseEffects(lease, false));
  } else if (lease._tag === "Stopping" || lease._tag === "Stopped") {
    effects.push(...releaseEffects(lease, true));
  }

  const pending: Lease = { _tag: "Pending", generation };

  effects.push(
    { _tag: "Persist", lease: pending },
    { _tag: "Arm" },
    admit("reserve", generation)
  );

  return next(pending, effects);
};

const started = (lease: Lease, facts: LeaseFacts): LeaseDecision => {
  if (facts.container !== "running") {
    // A container that outlived its lease must not keep running unowned.
    return refused([{ _tag: "Destroy" }]);
  }

  if (lease._tag === "Pending") {
    const running: Lease = { _tag: "Running", generation: lease.generation };

    return next(running, [
      admit("started", lease.generation),
      { _tag: "MarkRunning", generation: lease.generation },
      { _tag: "Touch" },
      { _tag: "Arm" },
    ]);
  }

  if (lease._tag === "Running") {
    return next(lease, [{ _tag: "Arm" }]);
  }

  return refused([{ _tag: "Destroy" }]);
};

const recover = (lease: Lease, facts: LeaseFacts): LeaseDecision => {
  if (lease._tag === "Absent") {
    return next(lease, []);
  }

  if (lease._tag === "Stopping" || lease._tag === "Stopped") {
    // Re-read and re-step under the lease lock: a release computed from this
    // snapshot must never finish the teardown of a newer generation.
    return next({ _tag: "Stopped", generation: lease.generation }, [
      { _tag: "ReleaseNow" },
    ]);
  }

  if (lease._tag === "Pending") {
    return facts.starting
      ? next(lease, [{ _tag: "Arm" }])
      : next({ _tag: "Stopping", generation: lease.generation }, [
          { _tag: "Destroy" },
        ]);
  }

  return facts.container === "running"
    ? next(lease, [admit("heartbeat", lease.generation), { _tag: "Arm" }])
    : next({ _tag: "Stopping", generation: lease.generation }, [
        { _tag: "Destroy" },
      ]);
};

/**
 * The one transition function: `lease` + `event` + container facts in, the
 * next lease and the ordered effects out. Pure — the controller supplies the
 * clock, the generation and the storage.
 */
export const stepLease = (
  lease: Lease,
  event: LeaseEvent,
  facts: LeaseFacts
): LeaseDecision => {
  if (event._tag === "Start") {
    return start(lease, event.generation, facts);
  }

  if (event._tag === "Started") {
    return started(lease, facts);
  }

  if (event._tag === "Recover") {
    return recover(lease, facts);
  }

  if (event._tag === "Use") {
    return lease._tag === "Running"
      ? next(lease, [admit("heartbeat", lease.generation)])
      : refused([]);
  }

  if (facts.container === "running") {
    return refused([]);
  }

  if (lease._tag === "Absent") {
    return next(lease, []);
  }

  return next({ _tag: "Stopped", generation: lease.generation }, [
    ...releaseEffects(
      lease,
      lease._tag === "Stopping" || lease._tag === "Stopped"
    ),
  ]);
};
