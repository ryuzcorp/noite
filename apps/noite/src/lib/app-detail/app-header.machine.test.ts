import { describe, expect, test } from "bun:test";

import {
  HeaderMsg,
  HeaderNoticeTypes,
  PendingTypes,
  converged,
  updateHeader,
} from "./app-header.machine";
import type { HeaderModel } from "./app-header.machine";

const header = (patch: Partial<HeaderModel> = {}): HeaderModel => ({
  appId: "app_1",
  notice: HeaderNoticeTypes.None(),
  pending: PendingTypes.Idle(),
  seq: 0,
  ...patch,
});

describe("updateHeader", () => {
  test("a second toggle while starting is refused", () => {
    const first = updateHeader(
      header(),
      HeaderMsg.ToggleRequested({ next: "stopped" })
    );

    const second = updateHeader(
      first.model,
      HeaderMsg.ToggleRequested({ next: "running" })
    );

    expect(first.model.pending._tag).toBe("Stopping");
    expect(second.cmd).toBeUndefined();
    expect(second.model).toBe(first.model);
  });

  test("a matching frame ends the wait", () => {
    const stopping = updateHeader(
      header(),
      HeaderMsg.ToggleRequested({ next: "stopped" })
    );

    const done = updateHeader(
      stopping.model,
      HeaderMsg.FrameReceived({ desiredState: "stopped", status: "stopped" })
    );

    expect(done.model.pending._tag).toBe("Idle");
  });

  test("a starting app that converged to sleeping counts as done", () => {
    const starting = updateHeader(
      header(),
      HeaderMsg.ToggleRequested({ next: "running" })
    );

    const done = updateHeader(
      starting.model,
      HeaderMsg.FrameReceived({ desiredState: "running", status: "sleeping" })
    );

    expect(done.model.pending._tag).toBe("Idle");
  });

  test("a superseded deadline does not touch a newer action", () => {
    const first = updateHeader(
      header(),
      HeaderMsg.ToggleRequested({ next: "stopped" })
    );

    const settled = updateHeader(
      first.model,
      HeaderMsg.Settled({ action: "stop", seq: 99 })
    );

    expect(settled.model.pending._tag).toBe("Stopping");
    expect(settled.model.notice._tag).toBe("None");
  });

  test("a deadline paints an explicit TimedOut notice", () => {
    const stopping = updateHeader(
      header(),
      HeaderMsg.ToggleRequested({ next: "stopped" })
    );

    const timedOut = updateHeader(
      stopping.model,
      HeaderMsg.Settled({ action: "stop", seq: stopping.model.seq })
    );

    expect(timedOut.model.pending._tag).toBe("Idle");
    expect(timedOut.model.notice).toEqual(
      HeaderNoticeTypes.TimedOut({ action: "stop" })
    );
  });

  test("a retry is done as soon as the app leaves importing", () => {
    expect(
      converged(PendingTypes.Retrying({ seq: 1 }), "building", "running")
    ).toBe(true);
    expect(
      converged(PendingTypes.Retrying({ seq: 1 }), "importing", "running")
    ).toBe(false);
  });
});
