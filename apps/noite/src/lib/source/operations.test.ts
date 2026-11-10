import { expect, test } from "bun:test";

import {
  previewView,
  PreviewOps,
  pushView,
  PushOps,
  resetOperations,
  settlePreview,
  settlePush,
  startPreview,
  startPush,
} from "./operations";

/** A start the test expects to be accepted (the refusal cases assert on the
 * null directly). */
const started = <T>(value: T | null): T => {
  if (value === null) {
    throw new Error("expected the operation to start");
  }

  return value;
};

test("a preview failure never reports as a push failure", () => {
  const preview = settlePreview(started(startPreview(PreviewOps.Idle())), {
    message: "preview refused",
    ok: false,
  });

  expect(previewView(preview).previewError).toBe("preview refused");
  // The push slot was never touched.
  const push = pushView(PushOps.Idle());

  expect(push.pushError).toBe("");
  expect(push.pushing).toBe(false);
});

test("a push failure never reports as a preview failure", () => {
  const push = settlePush(started(startPush(PushOps.Idle())), {
    message: "push refused",
    ok: false,
  });

  expect(pushView(push).pushError).toBe("push refused");
  expect(previewView(PreviewOps.Idle()).previewError).toBe("");
});

test("one push and one preview at a time, and they do not block each other", () => {
  const pushing = started(startPush(PushOps.Idle()));

  expect(startPush(pushing)).toBeNull();

  const running = started(startPreview(PreviewOps.Idle()));

  expect(startPreview(running)).toBeNull();

  // Both are in flight at once.
  expect(pushView(pushing).pushing).toBe(true);
  expect(previewView(running).previewed).toBeNull();
});

test("a landed push reports where it went, and a change resets it", () => {
  const push = settlePush(started(startPush(PushOps.Idle())), {
    ok: true,
    to: { branch: "feature", newBranch: true },
  });

  expect(pushView(push).pushed).toEqual({ branch: "feature", newBranch: true });

  const reset = resetOperations();

  expect(pushView(reset.push).pushed).toBeNull();
  expect(pushView(reset.push).pushing).toBe(false);
});
