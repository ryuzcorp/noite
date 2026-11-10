import { describe, expect, test } from "bun:test";

import {
  Address,
  Deploy,
  PreviewFrame,
  PreviewFreshness,
  addressTransition,
  deployTransition,
  previewFrameTransition,
  previewFreshness,
} from "./preview-machine";

const loading = (token: string) => PreviewFrame.Loading({ token });

describe("previewFrameTransition", () => {
  test("a load for the current navigation makes it live", () => {
    expect(
      previewFrameTransition(loading("a"), { t: "loaded", token: "a" })
    ).toEqual(PreviewFrame.Live({ token: "a" }));
  });

  test("a load for an older navigation is ignored", () => {
    expect(
      previewFrameTransition(loading("b"), { t: "loaded", token: "a" })
    ).toEqual(loading("b"));
  });

  test("the deadline stalls the current navigation only", () => {
    expect(
      previewFrameTransition(loading("a"), { t: "timeout", token: "a" })
    ).toEqual(PreviewFrame.Stalled({ token: "a" }));
    expect(
      previewFrameTransition(PreviewFrame.Live({ token: "a" }), {
        t: "timeout",
        token: "a",
      })
    ).toEqual(PreviewFrame.Live({ token: "a" }));
  });

  test("a deploy that goes live revives a stalled frame", () => {
    const stalled = PreviewFrame.Stalled({ token: "a" });

    expect(previewFrameTransition(stalled, { t: "arm", token: "b" })).toEqual(
      loading("b")
    );
  });
});

describe("previewFreshness", () => {
  test("no snapshot and no changes is nothing deployed", () => {
    expect(
      previewFreshness({ changes: 0, current: "x", snapshotted: null })
    ).toEqual(PreviewFreshness.None());
  });

  test("a matching fingerprint is fresh, a moved one counts the edits", () => {
    expect(
      previewFreshness({ changes: 2, current: "x", snapshotted: "x" })
    ).toEqual(PreviewFreshness.Fresh());
    expect(
      previewFreshness({ changes: 2, current: "y", snapshotted: "x" })
    ).toEqual(PreviewFreshness.Behind({ changes: 2 }));
  });

  test("edits with no recorded snapshot are unknown, not fresh", () => {
    expect(
      previewFreshness({ changes: 1, current: "x", snapshotted: null })
    ).toEqual(PreviewFreshness.Unknown());
  });
});

describe("deployTransition", () => {
  test("a second click cannot deploy twice", () => {
    const running = deployTransition(Deploy.Idle(), { t: "submit" });

    expect(running).toEqual(Deploy.Snapshotting());
    expect(deployTransition(running, { t: "submit" })).toEqual(running);
  });

  test("a failed snapshot can be retried", () => {
    const running = deployTransition(Deploy.Failed({ message: "x" }), {
      t: "submit",
    });

    expect(running).toEqual(Deploy.Snapshotting());
    expect(deployTransition(running, { message: "no", t: "failed" })).toEqual(
      Deploy.Failed({ message: "no" })
    );
  });

  test("a success and a failure only land on a snapshotting state", () => {
    expect(deployTransition(Deploy.Idle(), { t: "succeeded" })).toEqual(
      Deploy.Idle()
    );
    expect(
      deployTransition(Deploy.Idle(), { message: "x", t: "failed" })
    ).toEqual(Deploy.Idle());
    expect(deployTransition(Deploy.Snapshotting(), { t: "succeeded" })).toEqual(
      Deploy.Done()
    );
  });
});

describe("addressTransition", () => {
  test("typing is editing, a bad submit is invalid, navigating is display", () => {
    const typing = addressTransition(Address.Display(), {
      t: "type",
      text: "x",
    });

    expect(typing).toEqual(Address.Editing({ text: "x" }));
    expect(addressTransition(typing, { t: "invalid", text: "x" })).toEqual(
      Address.Invalid({ text: "x" })
    );
    expect(addressTransition(typing, { t: "navigate" })).toEqual(
      Address.Display()
    );
    expect(addressTransition(typing, { t: "clear" })).toEqual(
      Address.Display()
    );
  });
});
