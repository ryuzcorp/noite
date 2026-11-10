import { describe, expect, test } from "bun:test";

import {
  Authority,
  authorityFromWire,
  authorityOf,
  authorityWire,
  mayAdministerInstance,
  overviewAuthority,
} from "./authority";

/** A resource that has not answered yet (typed `X | undefined`). */
const ABSENT: { authority: "plain" } | undefined = [][0];

const base = {
  adminEmail: null,
  banned: false,
  email: "user@example.com",
  impersonatedBy: null,
  role: "user",
};

describe("authorityOf", () => {
  test("no email is Anonymous", () => {
    expect(authorityOf({ ...base, email: "" })._tag).toBe("Anonymous");
    expect(authorityOf({ ...base, email: null })._tag).toBe("Anonymous");
  });

  test("the role makes an instance admin", () => {
    const authority = authorityOf({ ...base, role: "admin" });

    expect(authority).toEqual(Authority.InstanceAdmin({ via: "role" }));
    expect(mayAdministerInstance(authority)).toBe(true);
  });

  test("the env anchor makes an instance admin when the role is not set yet", () => {
    const authority = authorityOf({
      ...base,
      adminEmail: "User@Example.com ",
      role: null,
    });

    expect(authority).toEqual(Authority.InstanceAdmin({ via: "anchor" }));
  });

  test("a plain account is not an admin", () => {
    expect(mayAdministerInstance(authorityOf(base))).toBe(false);
  });

  test("an impersonated session is never an instance admin, whatever the role", () => {
    const authority = authorityOf({
      ...base,
      adminEmail: "user@example.com",
      impersonatedBy: "admin-1",
      role: "admin",
    });

    expect(authority).toEqual(Authority.Impersonating({ by: "admin-1" }));
    expect(mayAdministerInstance(authority)).toBe(false);
  });

  test("a banned session is refused before any admin test", () => {
    const authority = authorityOf({ ...base, banned: true, role: "admin" });

    expect(authority._tag).toBe("Banned");
    expect(mayAdministerInstance(authority)).toBe(false);
  });

  test("the wire form round-trips for the states the client reads", () => {
    for (const authority of [
      Authority.Anonymous(),
      Authority.Banned(),
      Authority.Impersonating({ by: "x" }),
      Authority.InstanceAdmin({ via: "role" }),
      Authority.Plain(),
    ]) {
      expect(authorityFromWire(authorityWire(authority))._tag).toBe(
        authority._tag
      );
    }
  });

  test("a missing overview is not an admin", () => {
    // The resource has not answered yet: no overview means no power.
    expect(mayAdministerInstance(overviewAuthority(ABSENT))).toBe(false);
  });
});
