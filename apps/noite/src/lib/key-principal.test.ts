import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_WIDE,
  attributor,
  decideKeyAccess,
  effectiveRole,
  keyCoversApp,
  keyExpired,
  keyScopeOf,
  parseKeyScope,
} from "./key-principal";
import type { KeyPrincipal, KeyScope } from "./key-principal";
import { roleAtLeast } from "./roles";
import type { AppRole } from "./roles";

const principal = (
  scope: Partial<KeyScope> = {},
  expiresAt: Date | null = null
): KeyPrincipal => ({
  expiresAt,
  keyId: "key-1",
  keyName: "ci",
  scope: { ...ACCOUNT_WIDE, ...scope },
  userId: "u-1",
});

describe("parseKeyScope", () => {
  test("a key with no metadata is account-wide", () => {
    for (const missing of [null, undefined]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- two absent shapes, asserted in order
      expect(parseKeyScope(missing)._tag).toBe("Account");
    }

    expect(keyScopeOf(parseKeyScope(null))).toEqual(ACCOUNT_WIDE);
  });

  test("an empty metadata object is account-wide, not malformed", () => {
    expect(keyScopeOf(parseKeyScope({}))).toEqual(ACCOUNT_WIDE);
  });

  test("unknown fields are ignored, known ones are read", () => {
    expect(
      keyScopeOf(parseKeyScope({ appIds: ["a", "b", "a"], future: true }))
    ).toEqual({ appIds: ["a", "b"], roleCeiling: "admin" });

    expect(
      keyScopeOf(parseKeyScope({ appIds: null, roleCeiling: "push" }))
    ).toEqual({ appIds: null, roleCeiling: "push" });
  });

  test("a metadata that does not describe a scope is malformed", () => {
    // A string/array/scalar is not metadata; each known field of the wrong
    // shape is refused rather than guessed at.
    const malformed: unknown[] = [
      "noite_abc",
      ["app-1"],
      42,
      { appIds: "app-1" },
      { appIds: [] },
      { appIds: [""] },
      { appIds: [1] },
      { roleCeiling: "owner" },
      { roleCeiling: 3 },
    ];

    for (const metadata of malformed) {
      expect(parseKeyScope(metadata)._tag, JSON.stringify(metadata)).toBe(
        "Malformed"
      );
    }
  });
});

describe("effectiveRole", () => {
  const table: readonly (readonly [AppRole, AppRole, AppRole])[] = [
    ["admin", "admin", "admin"],
    ["admin", "push", "push"],
    ["admin", "view", "view"],
    ["push", "admin", "push"],
    ["push", "push", "push"],
    ["push", "view", "view"],
    ["view", "admin", "view"],
    ["view", "push", "view"],
    ["view", "view", "view"],
  ];

  test("is the lower of the owner's role and the ceiling", () => {
    for (const [account, ceiling, expected] of table) {
      expect(effectiveRole(account, ceiling)).toBe(expected);
      // A ceiling never grants: the result is never above the owner's role.
      expect(roleAtLeast(account, effectiveRole(account, ceiling))).toBe(true);
    }
  });
});

describe("keyCoversApp", () => {
  test("account-wide covers every app; a set covers only its ids", () => {
    expect(keyCoversApp(ACCOUNT_WIDE, "app-1")).toBe(true);
    expect(
      keyCoversApp({ appIds: ["app-1"], roleCeiling: "view" }, "app-1")
    ).toBe(true);
    expect(
      keyCoversApp({ appIds: ["app-1"], roleCeiling: "view" }, "app-2")
    ).toBe(false);
  });
});

describe("keyExpired", () => {
  test("a key with no expiry never expires", () => {
    expect(keyExpired(principal(), new Date("2099-01-01T00:00:00Z"))).toBe(
      false
    );
  });

  test("the expiry instant itself is already expired", () => {
    const at = new Date("2026-11-11T12:00:00Z");

    expect(keyExpired(principal({}, at), at)).toBe(true);
    expect(keyExpired(principal({}, at), new Date(at.getTime() - 1))).toBe(
      false
    );
  });
});

/** Every combination the enforcement function decides: the key's app set, the
 * owner's role on that app, the key's expiry and the role the surface needs.
 * `scope` is the app id the key covers, `null` for account-wide. */
const CASES: readonly {
  accountRole: AppRole | null;
  ceiling: AppRole;
  expected: string;
  need: AppRole;
  scope: readonly string[] | null;
}[] = [
  // Expiry wins over everything, including a fully allowed app.
  {
    accountRole: "admin",
    ceiling: "admin",
    expected: "Expired",
    need: "view",
    scope: null,
  },
  // The app set is checked before the role: a foreign app is not an oracle
  // for whether the owner could have acted there.
  {
    accountRole: "admin",
    ceiling: "admin",
    expected: "OutsideScope",
    need: "view",
    scope: ["other-app"],
  },
  {
    accountRole: null,
    ceiling: "admin",
    expected: "OutsideScope",
    need: "view",
    scope: ["other-app"],
  },
  // No role on the app, whatever the ceiling.
  {
    accountRole: null,
    ceiling: "admin",
    expected: "NoAccess",
    need: "view",
    scope: null,
  },
  // The ceiling caps a higher owner role.
  {
    accountRole: "admin",
    ceiling: "push",
    expected: "Insufficient:push",
    need: "admin",
    scope: null,
  },
  {
    accountRole: "admin",
    ceiling: "view",
    expected: "Insufficient:view",
    need: "push",
    scope: ["app-1"],
  },
  // The owner's role caps a higher ceiling.
  {
    accountRole: "push",
    ceiling: "admin",
    expected: "Insufficient:push",
    need: "admin",
    scope: null,
  },
  // Allowed, with the effective role.
  {
    accountRole: "admin",
    ceiling: "push",
    expected: "Granted:push",
    need: "push",
    scope: null,
  },
  {
    accountRole: "admin",
    ceiling: "view",
    expected: "Granted:view",
    need: "view",
    scope: ["app-1"],
  },
  {
    accountRole: "push",
    ceiling: "push",
    expected: "Granted:push",
    need: "push",
    scope: null,
  },
  {
    accountRole: "view",
    ceiling: "admin",
    expected: "Granted:view",
    need: "view",
    scope: ["app-1"],
  },
];

describe("decideKeyAccess", () => {
  test("scope × role × ceiling × expiry decides one verdict", () => {
    const now = new Date("2026-11-11T12:00:00Z");

    for (const row of CASES) {
      const expired = row.expected === "Expired";

      const access = decideKeyAccess({
        accountRole: row.accountRole,
        appId: "app-1",
        need: row.need,
        now,
        principal: principal(
          { appIds: row.scope, roleCeiling: row.ceiling },
          expired ? new Date(now.getTime() - 1) : null
        ),
      });

      const described =
        access._tag === "Granted" || access._tag === "Insufficient"
          ? `${access._tag}:${access.role}`
          : access._tag;

      expect(
        described,
        `scope=${JSON.stringify(row.scope)} role=${row.accountRole} ceiling=${row.ceiling} need=${row.need}`
      ).toBe(row.expected);
    }
  });
});

describe("attributor", () => {
  test("names the key behind a bot action", () => {
    expect(attributor("Ada", "ci")).toBe("Ada via key ci");
  });

  test("an unnamed key or account still reads as a person", () => {
    expect(attributor("Ada", " ")).toBe("Ada");
    expect(attributor("  ", "ci")).toBe("Noite user via key ci");
  });
});
