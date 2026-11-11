import { describe, expect, test } from "bun:test";

import { advanceWait, WaitEvents, WaitPhases } from "./deploy.js";

describe("deploy wait's machine", () => {
  test("a settled deploy is terminal", () => {
    const phase = advanceWait(
      WaitPhases.Waiting({ status: "building" }),
      WaitEvents.Observed({ done: true, status: "success" })
    );

    expect(phase).toEqual(WaitPhases.Settled({ status: "success" }));
  });

  test("a moving deploy re-arms with the status it last saw", () => {
    const phase = advanceWait(
      WaitPhases.Waiting({ status: null }),
      WaitEvents.Observed({ done: false, status: "building" })
    );

    expect(phase).toEqual(WaitPhases.Waiting({ status: "building" }));
  });

  test("the deadline gives up, naming the last status", () => {
    const phase = advanceWait(
      WaitPhases.Waiting({ status: "deploying" }),
      WaitEvents.Deadline()
    );

    expect(phase).toEqual(WaitPhases.GaveUp({ status: "deploying" }));
  });

  test("done without a status still settles", () => {
    const phase = advanceWait(
      WaitPhases.Waiting({ status: null }),
      WaitEvents.Observed({ done: true, status: null })
    );

    expect(phase).toEqual(WaitPhases.Settled({ status: "unknown" }));
  });

  test("a settled or given-up phase has no further transition", () => {
    expect(() =>
      advanceWait(
        WaitPhases.Settled({ status: "success" }),
        WaitEvents.Deadline()
      )
    ).toThrow(/illegal wait transition/u);
  });
});
