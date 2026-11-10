/**
 * Sandbox activity machine: whether the cell is doing work, plus the idle
 * deadline the alarm reaps on.
 *
 * Only `{ lastActivity, idleDeadline }` is durable (the `__voidSandboxActivity`
 * shape is unchanged); the in-flight count lives in the isolate. Every read
 * and write goes through the controller's serialized queue, so the alarm's
 * check-and-destroy cannot interleave with a request that is starting: a
 * `Begin` either lands first (the tick sees `Busy` and keeps the cell) or
 * sees `Expired` and is refused before it touches the container.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Absent
 *   Absent --> Busy: Begin / Touch / Tick
 *   Idle --> Busy: Begin
 *   Busy --> Busy: Begin / End (count > 1)
 *   Busy --> Idle: End (count 1)
 *   Busy --> Busy: Touch / End with the container gone
 *   Idle --> Idle: Touch
 *   Idle --> Expired: Tick (now >= deadline)
 *   Expired --> Expired: Tick (reap retry) / Begin refused
 *   Expired --> Absent: Clear (teardown)
 * ```
 *
 * `Expired` is the reap lock: it is only entered with no request in flight,
 * and it refuses new work until teardown clears it. `Touch` never resurrects
 * it — a lifecycle touch during a reap must not let work onto a dying cell.
 */

export interface ActivityRecord {
  readonly idleDeadline: number;
  readonly lastActivity: number;
}

export type Activity =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Idle"; readonly record: ActivityRecord }
  | {
      readonly _tag: "Busy";
      readonly count: number;
      readonly record: ActivityRecord;
    }
  | { readonly _tag: "Expired"; readonly record: ActivityRecord };

export type ActivityEvent =
  | { readonly _tag: "Begin"; readonly at: number; readonly timeoutMs: number }
  | {
      readonly _tag: "End";
      readonly at: number;
      readonly running: boolean;
      readonly timeoutMs: number;
    }
  | { readonly _tag: "Touch"; readonly at: number; readonly timeoutMs: number }
  | { readonly _tag: "Configure"; readonly timeoutMs: number }
  | { readonly _tag: "Tick"; readonly now: number; readonly timeoutMs: number };

export type ActivityDecision =
  | { readonly _tag: "Refused" }
  | {
      readonly _tag: "Ok";
      readonly activity: Activity;
      /** Record to persist, when the transition moved the deadline. */
      readonly persist?: ActivityRecord;
      /** True only when the alarm should tear the cell down. */
      readonly reap: boolean;
    };

/** Derive the activity from the stored `{ lastActivity, idleDeadline }`. */
export const decodeActivity = (value?: ActivityRecord): Activity =>
  value === undefined ? { _tag: "Absent" } : { _tag: "Idle", record: value };

const touch = (at: number, timeoutMs: number): ActivityRecord => ({
  idleDeadline: at + timeoutMs,
  lastActivity: at,
});

const ok = (
  activity: Activity,
  persist: ActivityRecord | undefined,
  reap: boolean
): ActivityDecision =>
  persist === undefined
    ? { _tag: "Ok", activity, reap }
    : { _tag: "Ok", activity, persist, reap };

const begin = (
  activity: Activity,
  event: Extract<ActivityEvent, { readonly _tag: "Begin" }>
): ActivityDecision => {
  if (activity._tag === "Expired") {
    return { _tag: "Refused" };
  }

  const record = touch(event.at, event.timeoutMs);
  const count = activity._tag === "Busy" ? activity.count + 1 : 1;

  return ok({ _tag: "Busy", count, record }, record, false);
};

const end = (
  activity: Activity,
  event: Extract<ActivityEvent, { readonly _tag: "End" }>
): ActivityDecision => {
  if (activity._tag !== "Busy") {
    return ok(activity, undefined, false);
  }

  // A finished request only renews the deadline while the container lives.
  const record = event.running
    ? touch(event.at, event.timeoutMs)
    : activity.record;

  const persist = event.running ? record : undefined;

  return activity.count > 1
    ? ok({ _tag: "Busy", count: activity.count - 1, record }, persist, false)
    : ok({ _tag: "Idle", record }, persist, false);
};

const renew = (
  activity: Activity,
  event: Extract<ActivityEvent, { readonly _tag: "Touch" }>
): ActivityDecision => {
  const record = touch(event.at, event.timeoutMs);

  if (activity._tag === "Expired") {
    // The reap lock wins over a lifecycle ping.
    return ok(activity, undefined, false);
  }

  if (activity._tag === "Busy") {
    return ok({ _tag: "Busy", count: activity.count, record }, record, false);
  }

  return ok({ _tag: "Idle", record }, record, false);
};

const configure = (
  activity: Activity,
  event: Extract<ActivityEvent, { readonly _tag: "Configure" }>
): ActivityDecision => {
  if (activity._tag !== "Idle" && activity._tag !== "Busy") {
    return ok(activity, undefined, false);
  }

  const record = {
    idleDeadline: activity.record.lastActivity + event.timeoutMs,
    lastActivity: activity.record.lastActivity,
  };

  return activity._tag === "Idle"
    ? ok({ _tag: "Idle", record }, record, false)
    : ok({ _tag: "Busy", count: activity.count, record }, record, false);
};

const tick = (
  activity: Activity,
  event: Extract<ActivityEvent, { readonly _tag: "Tick" }>
): ActivityDecision => {
  if (activity._tag === "Busy") {
    // A live request pins the cell regardless of the stale deadline.
    return ok(activity, undefined, false);
  }

  if (activity._tag === "Expired") {
    return ok(activity, undefined, true);
  }

  if (activity._tag === "Idle") {
    return event.now >= activity.record.idleDeadline
      ? ok({ _tag: "Expired", record: activity.record }, undefined, true)
      : ok(activity, undefined, false);
  }

  const record = touch(event.now, event.timeoutMs);

  return ok({ _tag: "Idle", record }, record, false);
};

/** The one transition function for activity. Pure; the caller owns the clock. */
export const stepActivity = (
  activity: Activity,
  event: ActivityEvent
): ActivityDecision => {
  if (event._tag === "Begin") {
    return begin(activity, event);
  }

  if (event._tag === "End") {
    return end(activity, event);
  }

  if (event._tag === "Touch") {
    return renew(activity, event);
  }

  if (event._tag === "Configure") {
    return configure(activity, event);
  }

  return tick(activity, event);
};
