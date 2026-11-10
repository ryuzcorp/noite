import { describe, expect, test } from "bun:test";

import { fleetState, telemetryAvailable } from "./control-fleet";

describe("fleetState", () => {
  test("no answer is Unknown, not Managed", () => {
    expect(fleetState()._tag).toBe("Unknown");
    expect(telemetryAvailable(fleetState())).toBe(false);
  });

  test("true is Managed, false is Absent", () => {
    expect(fleetState(true)._tag).toBe("Managed");
    expect(fleetState(false)._tag).toBe("Absent");
    expect(telemetryAvailable(fleetState(true))).toBe(true);
  });
});
