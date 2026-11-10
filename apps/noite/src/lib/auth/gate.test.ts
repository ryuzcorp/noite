import { describe, expect, test } from "bun:test";

import type { SessionView } from "../resources";
import {
  SESSION_RETRY_BUDGET,
  GateEvt,
  GateState,
  gateTransition,
} from "./gate";

const session: SessionView = {
  session: { impersonatedBy: null },
  user: {
    email: "user@example.com",
    id: "u-1",
    name: "User",
    onboardedAt: "2026-11-01",
  },
};

describe("gateTransition", () => {
  test("a readable session is Authed", () => {
    const next = gateTransition(
      GateState.Checking({ attempt: 1 }),
      GateEvt.Read({ session })
    );

    expect(next).toEqual(GateState.Authed({ session }));
  });

  test("a failed read is Failed, not a skeleton and not signed out", () => {
    // The bug this pins: the old gate awaited refetch() with no catch, so a
    // rejected session read left the dashboard skeleton up forever.
    const next = gateTransition(
      GateState.Checking({ attempt: 1 }),
      GateEvt.ReadFailed({ message: "store unavailable" })
    );

    expect(next).toEqual(GateState.Failed({ message: "store unavailable" }));
  });

  test("Retry from Failed goes back to Checking, not to the skeleton state", () => {
    expect(
      gateTransition(GateState.Failed({ message: "boom" }), GateEvt.Retry())
    ).toEqual(GateState.Checking({ attempt: 0 }));
  });

  test("a read with no user retries until the budget, then signs out", () => {
    let state = gateTransition(GateState.Ssr(), GateEvt.Retry());

    for (let i = 1; i < SESSION_RETRY_BUDGET; i += 1) {
      state = gateTransition(state, GateEvt.Read({ session: null }));

      if (i < SESSION_RETRY_BUDGET - 1) {
        expect(state._tag).toBe("Checking");
      }
    }

    // The steady state after the budget: the post-registration cookie race is
    // over, so the gate bounces instead of polling forever.
    state = gateTransition(state, GateEvt.Read({ session: null }));
    expect(state._tag).toBe("SignedOut");
  });

  test("a read after Failed keeps the failure (no silent recovery)", () => {
    expect(
      gateTransition(
        GateState.Failed({ message: "boom" }),
        GateEvt.Read({ session: null })
      )
    ).toEqual(GateState.Failed({ message: "boom" }));
  });
});
