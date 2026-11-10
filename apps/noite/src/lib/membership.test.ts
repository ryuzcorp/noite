import { describe, expect, test } from "bun:test";

import { decideAccept, decideGrant, decideRemove } from "./membership";

describe("decideGrant", () => {
  test("the last admin cannot be demoted", () => {
    expect(
      decideGrant({ adminCount: 1, current: "admin", next: "view" })
    ).toEqual({ _tag: "Refused", reason: "last-admin" });
  });

  test("the last admin cannot be removed either", () => {
    expect(decideRemove({ adminCount: 1, current: "admin" })).toEqual({
      _tag: "Refused",
      reason: "last-admin",
    });
  });

  test("an admin among others may be demoted, and removing a non-admin is fine", () => {
    expect(
      decideGrant({ adminCount: 2, current: "admin", next: "push" })
    ).toEqual({ _tag: "Applies", role: "push" });
    expect(decideRemove({ adminCount: 1, current: "view" })).toEqual({
      _tag: "Applies",
    });
  });

  test("re-inviting an existing member with a lower role is refused at the last admin", () => {
    // The old invite path wrote the role with no count check, so an app's only
    // admin could be demoted by re-inviting their own address.
    expect(
      decideGrant({ adminCount: 1, current: "admin", next: "view" })
    ).toEqual({ _tag: "Refused", reason: "last-admin" });
  });
});

describe("decideAccept", () => {
  test("no grant: the invitation's role is written", () => {
    expect(
      decideAccept({
        adminCount: 1,
        grant: null,
        invite: { createdAt: "2026-11-01T00:00:00.000Z", role: "push" },
      })
    ).toEqual({ _tag: "Applies", role: "push" });
  });

  test("an invitation older than the grant never downgrades it", () => {
    expect(
      decideAccept({
        adminCount: 2,
        grant: { createdAt: "2026-11-02T00:00:00.000Z", role: "admin" },
        invite: { createdAt: "2026-11-01T00:00:00.000Z", role: "view" },
      })
    ).toEqual({ _tag: "Keep", role: "admin" });
  });

  test("a newer invitation applies, including a downgrade among several admins", () => {
    expect(
      decideAccept({
        adminCount: 2,
        grant: { createdAt: "2026-11-01T00:00:00.000Z", role: "admin" },
        invite: { createdAt: "2026-11-02T00:00:00.000Z", role: "view" },
      })
    ).toEqual({ _tag: "Applies", role: "view" });
  });

  test("a newer downgrade is refused when it would strand the app", () => {
    expect(
      decideAccept({
        adminCount: 1,
        grant: { createdAt: "2026-11-01T00:00:00.000Z", role: "admin" },
        invite: { createdAt: "2026-11-02T00:00:00.000Z", role: "view" },
      })
    ).toEqual({ _tag: "Refused", reason: "last-admin" });
  });

  test("an upgrade always applies", () => {
    expect(
      decideAccept({
        adminCount: 1,
        grant: { createdAt: "2026-11-02T00:00:00.000Z", role: "view" },
        invite: { createdAt: "2026-11-01T00:00:00.000Z", role: "admin" },
      })
    ).toEqual({ _tag: "Applies", role: "admin" });
  });
});
