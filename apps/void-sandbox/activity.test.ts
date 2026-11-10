// The activity machine: the idle check, the reap lock and the count.
import { describe, expect, test } from "bun:test";

import { decodeActivity, stepActivity } from "./src/activity.ts";
import type { Activity } from "./src/activity.ts";

const timeoutMs = 1000;

const idle: Activity = {
  _tag: "Idle",
  record: { idleDeadline: 1000, lastActivity: 0 },
};

describe("decode", () => {
  test("derives Idle from the stored record and Absent otherwise", () => {
    expect(decodeActivity({ idleDeadline: 5, lastActivity: 1 })).toEqual({
      _tag: "Idle",
      record: { idleDeadline: 5, lastActivity: 1 },
    });
    expect(decodeActivity()).toEqual({ _tag: "Absent" });
    expect(decodeActivity()).toEqual({ _tag: "Absent" });
  });
});

describe("Begin / End", () => {
  test("a request moves the deadline and counts", () => {
    const decision = stepActivity(idle, { _tag: "Begin", at: 500, timeoutMs });

    expect(decision).toMatchObject({
      activity: {
        _tag: "Busy",
        count: 1,
        record: { idleDeadline: 1500, lastActivity: 500 },
      },
      persist: { idleDeadline: 1500, lastActivity: 500 },
    });
  });

  test("concurrent requests stack", () => {
    const first = stepActivity(idle, { _tag: "Begin", at: 500, timeoutMs });

    if (first._tag === "Refused") {
      throw new Error("expected an admitted begin");
    }

    const second = stepActivity(first.activity, {
      _tag: "Begin",
      at: 600,
      timeoutMs,
    });

    expect(second).toMatchObject({ activity: { _tag: "Busy", count: 2 } });
  });

  test("the last finish leaves the cell idle", () => {
    const busy = stepActivity(idle, { _tag: "Begin", at: 500, timeoutMs });

    if (busy._tag === "Refused") {
      throw new Error("expected an admitted begin");
    }

    const done = stepActivity(busy.activity, {
      _tag: "End",
      at: 700,
      running: true,
      timeoutMs,
    });

    expect(done).toMatchObject({
      activity: { _tag: "Idle", record: { idleDeadline: 1700 } },
      persist: { idleDeadline: 1700, lastActivity: 700 },
    });
  });

  test("a finish with the container gone keeps the record", () => {
    const busy: Activity = {
      _tag: "Busy",
      count: 1,
      record: { idleDeadline: 1000, lastActivity: 0 },
    };

    const done = stepActivity(busy, {
      _tag: "End",
      at: 700,
      running: false,
      timeoutMs,
    });

    expect(done).toMatchObject({ activity: { _tag: "Idle" } });
    expect(done._tag === "Ok" ? done.persist : "missing").toBeUndefined();
  });

  test("a double finish does not count down twice", () => {
    const decision = stepActivity(idle, {
      _tag: "End",
      at: 1,
      running: true,
      timeoutMs,
    });

    expect(decision).toMatchObject({ activity: { _tag: "Idle" }, reap: false });
  });
});

describe("Tick", () => {
  test("a busy cell is never reaped, however stale the deadline", () => {
    const busy: Activity = {
      _tag: "Busy",
      count: 1,
      record: { idleDeadline: 1, lastActivity: 0 },
    };

    const decision = stepActivity(busy, { _tag: "Tick", now: 10, timeoutMs });

    expect(decision).toMatchObject({ activity: { _tag: "Busy" }, reap: false });
  });

  test("an idle cell past its deadline becomes Expired and reaps", () => {
    const decision = stepActivity(idle, { _tag: "Tick", now: 1000, timeoutMs });

    expect(decision).toMatchObject({
      activity: { _tag: "Expired", record: idle.record },
      reap: true,
    });
  });

  test("a fresh idle cell is left alone", () => {
    const decision = stepActivity(idle, { _tag: "Tick", now: 999, timeoutMs });

    expect(decision).toMatchObject({ activity: { _tag: "Idle" }, reap: false });
  });

  test("an expired cell retries its reap", () => {
    const expired: Activity = { _tag: "Expired", record: idle.record };

    const decision = stepActivity(expired, {
      _tag: "Tick",
      now: 2000,
      timeoutMs,
    });

    expect(decision).toMatchObject({
      activity: { _tag: "Expired" },
      reap: true,
    });
  });

  test("an absent record starts a fresh deadline instead of reaping", () => {
    const decision = stepActivity(
      { _tag: "Absent" },
      { _tag: "Tick", now: 50, timeoutMs }
    );

    expect(decision).toMatchObject({
      activity: { _tag: "Idle" },
      persist: { idleDeadline: 1050, lastActivity: 50 },
      reap: false,
    });
  });
});

describe("the reap lock", () => {
  const expired: Activity = { _tag: "Expired", record: idle.record };

  test("a request that begins during the reap is refused", () => {
    expect(
      stepActivity(expired, { _tag: "Begin", at: 2000, timeoutMs })
    ).toEqual({ _tag: "Refused" });
  });

  test("a lifecycle touch does not clear it", () => {
    expect(
      stepActivity(expired, { _tag: "Touch", at: 2000, timeoutMs })
    ).toMatchObject({ activity: { _tag: "Expired" } });
  });
});

describe("Touch and Configure", () => {
  test("Touch renews an idle or busy record", () => {
    expect(
      stepActivity(idle, { _tag: "Touch", at: 300, timeoutMs })
    ).toMatchObject({
      activity: {
        _tag: "Idle",
        record: { idleDeadline: 1300, lastActivity: 300 },
      },
    });
    expect(
      stepActivity(
        {
          _tag: "Busy",
          count: 2,
          record: { idleDeadline: 1, lastActivity: 0 },
        },
        { _tag: "Touch", at: 300, timeoutMs }
      )
    ).toMatchObject({ activity: { _tag: "Busy", count: 2 } });
  });

  test("Touch seeds an absent record", () => {
    expect(
      stepActivity({ _tag: "Absent" }, { _tag: "Touch", at: 300, timeoutMs })
    ).toMatchObject({
      activity: { _tag: "Idle" },
      persist: { idleDeadline: 1300, lastActivity: 300 },
    });
  });

  test("Configure recomputes the deadline from the last activity", () => {
    const configured = stepActivity(idle, { _tag: "Configure", timeoutMs: 10 });

    expect(configured).toMatchObject({
      activity: { _tag: "Idle", record: { idleDeadline: 10, lastActivity: 0 } },
      persist: { idleDeadline: 10, lastActivity: 0 },
    });
  });
});
