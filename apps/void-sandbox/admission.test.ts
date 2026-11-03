// Fleet-local admission: cap, generation fencing, stopped-always-succeeds.
import { describe, expect, test } from "bun:test";

import { NoiteSandboxAdmission, readAdmissionCap } from "./src/admission.ts";
import { DEFAULT_MAX_CONCURRENT } from "./src/meta.ts";
import { FakeStorage, makeControllerEnv, makeCtx } from "./test-helpers.ts";

const makeAdmission = (
  storage = new FakeStorage(),
  maxConcurrent?: string
): NoiteSandboxAdmission =>
  new NoiteSandboxAdmission(
    makeCtx({ storage }),
    makeControllerEnv(maxConcurrent === undefined ? {} : { maxConcurrent })
  );

describe("readAdmissionCap", () => {
  test("absent var takes the default", () => {
    expect(readAdmissionCap()).toBe(DEFAULT_MAX_CONCURRENT);
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
  });

  test("plain integers parse, with whitespace tolerated", () => {
    expect(readAdmissionCap("4")).toBe(4);
    expect(readAdmissionCap(" 2 ")).toBe(2);
    expect(readAdmissionCap("0")).toBe(0);
  });

  test("unreadable values fall back to the default (fail closed)", () => {
    for (const raw of ["", "abc", "-3", "4x", "4.5", "none"]) {
      expect(readAdmissionCap(raw)).toBe(DEFAULT_MAX_CONCURRENT);
    }
  });
});

describe("reserve", () => {
  test("admits up to the default cap, then denies with concurrency", async () => {
    const admission = makeAdmission();

    const admitted = await Promise.all(
      ["i1", "i2", "i3", "i4"].map((id) => admission.reserve(id, "g1"))
    );

    for (const result of admitted) {
      expect(result).toEqual({ ok: true });
    }

    await expect(admission.reserve("i5", "g1")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
  });

  test("re-reserving the same id and generation is idempotent", async () => {
    const admission = makeAdmission();
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
  });

  test("same id with another generation is unavailable, never admitted", async () => {
    const admission = makeAdmission();
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.reserve("i1", "g2")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("malformed ids refuse without touching capacity", async () => {
    const admission = makeAdmission();
    await expect(admission.reserve("", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.reserve("i1", "")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    // Nothing was stored: a full cap still admits afterwards.
    const admitted = await Promise.all(
      ["i1", "i2", "i3", "i4"].map((id) => admission.reserve(id, "g1"))
    );

    for (const result of admitted) {
      expect(result).toEqual({ ok: true });
    }
  });

  test("cap 1 admits one; cap 0 admits nothing", async () => {
    const one = makeAdmission(new FakeStorage(), "1");
    await expect(one.reserve("a", "g")).resolves.toEqual({ ok: true });
    await expect(one.reserve("b", "g")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
    const zero = makeAdmission(new FakeStorage(), "0");
    await expect(zero.reserve("a", "g")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
  });

  test("concurrent reserves past the cap admit exactly the cap", async () => {
    const admission = makeAdmission(new FakeStorage(), "2");
    const ids = ["r1", "r2", "r3", "r4", "r5"];

    const results = await Promise.all(
      ids.map((id) => admission.reserve(id, "g1"))
    );

    const admitted = ids.filter((_, index) => results[index]?.ok === true);
    expect(admitted).toEqual(["r1", "r2"]);

    for (const result of results.filter((r) => !r.ok)) {
      expect(result).toEqual({ ok: false, reason: "concurrency" });
    }

    // Behaviorally exactly two hold capacity.
    await expect(admission.heartbeat("r1", "g1")).resolves.toEqual({
      ok: true,
    });
    await expect(admission.heartbeat("r2", "g1")).resolves.toEqual({
      ok: true,
    });
    await expect(admission.heartbeat("r3", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("started and heartbeat", () => {
  test("unknown ids and wrong generations are unavailable", async () => {
    const admission = makeAdmission();
    await expect(admission.started("nope", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.heartbeat("nope", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.started("i1", "g2")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.heartbeat("i1", "g2")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("malformed ids refuse", async () => {
    const admission = makeAdmission();
    await expect(admission.started("", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.heartbeat("i1", "")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("reserved entries heartbeat; started entries stay admitted", async () => {
    const admission = makeAdmission();
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.heartbeat("i1", "g1")).resolves.toEqual({
      ok: true,
    });
    await expect(admission.started("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.heartbeat("i1", "g1")).resolves.toEqual({
      ok: true,
    });
    await expect(admission.started("i1", "g1")).resolves.toEqual({ ok: true });
  });

  test("a cap shrink keeps the lowest ids deterministically", async () => {
    const storage = new FakeStorage();
    const before = makeAdmission(storage);

    const admitted = await Promise.all(
      ["n3", "n1", "n2"].map((id) => before.reserve(id, "g1"))
    );

    for (const result of admitted) {
      expect(result).toEqual({ ok: true });
    }

    // Same cells, tighter cap: a fresh instance re-reads the stored table.
    const after = makeAdmission(storage, "1");
    await expect(after.heartbeat("n1", "g1")).resolves.toEqual({ ok: true });
    await expect(after.heartbeat("n2", "g1")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
    await expect(after.heartbeat("n3", "g1")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
    await expect(after.reserve("n2", "g1")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
  });
});

describe("stopped", () => {
  test("unknown ids and wrong generations resolve (teardown always works)", async () => {
    const admission = makeAdmission();
    await expect(admission.stopped("ghost", "g1")).resolves.toBeUndefined();
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({
      ok: true,
    });
    await expect(admission.stopped("i1", "wrong")).resolves.toBeUndefined();
    // The live entry is untouched by the wrong-generation stop.
    await expect(admission.heartbeat("i1", "g1")).resolves.toEqual({
      ok: true,
    });
  });

  test("stopped resolves even when the cap is zeroed", async () => {
    const admission = makeAdmission(new FakeStorage(), "0");
    await expect(admission.stopped("ghost", "g1")).resolves.toBeUndefined();
  });

  test("stopping frees capacity and fences the generation", async () => {
    const admission = makeAdmission(new FakeStorage(), "1");
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.reserve("i2", "g1")).resolves.toEqual({
      ok: false,
      reason: "concurrency",
    });
    await expect(admission.stopped("i1", "g1")).resolves.toBeUndefined();
    await expect(admission.stopped("i1", "g1")).resolves.toBeUndefined();
    // Same generation never re-admitted; a fresh id takes the capacity.
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.reserve("i2", "g1")).resolves.toEqual({ ok: true });
  });

  test("a new generation for a stopped id is admitted", async () => {
    const admission = makeAdmission();
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    await expect(admission.stopped("i1", "g1")).resolves.toBeUndefined();
    await expect(admission.reserve("i1", "g2")).resolves.toEqual({ ok: true });
  });

  test("a stop that overtakes its reserve fences that generation", async () => {
    const admission = makeAdmission();
    await expect(admission.stopped("i1", "g1")).resolves.toBeUndefined();
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.reserve("i1", "g2")).resolves.toEqual({ ok: true });
  });

  test("malformed ids throw (programmer error, not an admission verdict)", async () => {
    const admission = makeAdmission();
    await expect(admission.stopped("", "g1")).rejects.toThrow(
      "Invalid Sandbox admission identity."
    );
    await expect(admission.stopped("i1", "x".repeat(129))).rejects.toThrow(
      "Invalid Sandbox admission identity."
    );
  });
});

describe("alarm", () => {
  test("an empty table is a no-op that writes nothing", async () => {
    const storage = new FakeStorage();
    const admission = makeAdmission(storage);
    await admission.alarm();
    expect(storage.puts).toBe(0);
  });

  test("a stop torn between mark and receipt is finished, fenced and freed", async () => {
    const storage = new FakeStorage();
    const admission = makeAdmission(storage, "1");
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({ ok: true });
    // Tear the stop: the mark (put 2) commits, the receipt (put 3) throws.
    storage.failPut = (putIndex): boolean => putIndex === 3;
    await expect(admission.stopped("i1", "g1")).rejects.toThrow("storage boom");
    storage.failPut = null;
    // The marked generation already refuses re-admission.
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    // And the alarm was armed for exactly this retry.
    expect(storage.alarmAt).not.toBeNull();
    await admission.alarm();
    // Receipt committed: the generation stays fenced, capacity is free.
    await expect(admission.reserve("i1", "g1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(admission.reserve("i2", "g1")).resolves.toEqual({ ok: true });
    // A second alarm finds nothing to do.
    const { puts } = storage;
    await admission.alarm();
    expect(storage.puts).toBe(puts);
  });
});
