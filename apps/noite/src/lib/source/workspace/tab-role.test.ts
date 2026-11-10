import { describe, expect, test } from "bun:test";

import { LOST_LOCK_MESSAGE, Role, maySave, roleTransition } from "./tab-role";
import type { RoleEvent, TabRole } from "./tab-role";

const boot = (event: RoleEvent): TabRole =>
  roleTransition(Role.Booting(), event);

describe("roleTransition", () => {
  test("a boot is one of the three roles", () => {
    expect(boot({ t: "boot-saving" })).toEqual(Role.Saving());
    expect(boot({ t: "boot-following" })).toEqual(Role.Following());
    expect(boot({ t: "boot-readonly" })).toEqual(Role.Readonly());
    expect(maySave(boot({ t: "boot-saving" }))).toBe(true);
    expect(maySave(boot({ t: "boot-following" }))).toBe(false);
    expect(maySave(boot({ t: "boot-readonly" }))).toBe(false);
  });

  test("a following tab saves only after the grant and the flush", () => {
    const granted = roleTransition(Role.Following(), { t: "granted" });

    // Granted is not saving: what piled up while following is still owed.
    expect(granted).toEqual(Role.TakingOver());
    expect(maySave(granted)).toBe(true);
    expect(roleTransition(granted, { t: "took-over" })).toEqual(Role.Saving());
  });

  test("a saving tab that loses the lock goes back to following", () => {
    // The bug this removes: `lock.onLost` was null, so a stolen lock left the
    // tab "saving" — every commit threw, and each refusal was reported as a
    // real save failure while nothing was kept.
    const lost = roleTransition(Role.Saving(), { t: "lock-lost" });

    expect(lost).toEqual(Role.Following());
    expect(maySave(lost)).toBe(false);
  });

  test("taking over can lose the lock too", () => {
    expect(roleTransition(Role.TakingOver(), { t: "lock-lost" })).toEqual(
      Role.Following()
    );
  });

  test("following ignores a second grant and a lost lock it never had", () => {
    expect(roleTransition(Role.Following(), { t: "lock-lost" })).toEqual(
      Role.Following()
    );
    expect(roleTransition(Role.Following(), { t: "took-over" })).toEqual(
      Role.Following()
    );
  });

  test("closed is terminal", () => {
    for (const role of [
      Role.Booting(),
      Role.Readonly(),
      Role.Following(),
      Role.TakingOver(),
      Role.Saving(),
    ]) {
      const closed = roleTransition(role, { t: "close" });

      expect(closed).toEqual(Role.Closed());
      expect(roleTransition(closed, { t: "granted" })).toEqual(closed);
      expect(roleTransition(closed, { t: "boot-saving" })).toEqual(closed);
      expect(roleTransition(closed, { t: "lock-lost" })).toEqual(closed);
      expect(maySave(closed)).toBe(false);
    }
  });

  test("the lost-lock report says nothing is being kept", () => {
    expect(LOST_LOCK_MESSAGE).toContain("not being saved");
  });
});
