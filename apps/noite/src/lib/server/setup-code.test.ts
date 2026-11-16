import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { controlEnv } from "../control-env";
import { ensureDb, setD1Binding } from "../db";
import { signupPolicy } from "./email-invites.server";
import {
  checkFirstAdminProof,
  checkSetupCode,
  claimFirstAdminSlot,
  consumeSetupCode,
  ensureSetupCode,
  hashSetupCode,
  newSetupCode,
  normalizeSetupCode,
  rotateSetupCode,
} from "./setup-code.server";

let db: TestD1;

/** A code that was never supplied (typed `string | undefined`). */
const ABSENT: string | undefined = [""][1];

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
  // The issue banner is loud on purpose; the assertions below read the rows.
  spyOn(console, "error").mockImplementation(() => {});
});

beforeEach(() => {
  db.raw.run(`DELETE FROM bootstrap_setup`);
  db.raw.run(`DELETE FROM "user"`);
  delete controlEnv.BASE_DOMAIN;
  delete controlEnv.NOITE_ADMIN_EMAIL;
});

const addUser = (id: string, email?: string, role = "user") => {
  db.raw.run(`INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, ?)`, [
    id,
    id,
    email ?? `${id}@example.com`,
    role,
  ]);
};

/** A public base: the proof gate applies (localhost keeps legacy). */
const publicBase = (anchor?: string) => {
  controlEnv.BASE_DOMAIN = "example.com";

  if (anchor !== undefined) {
    controlEnv.NOITE_ADMIN_EMAIL = anchor;
  }
};

// SAFETY: the query selects exactly the one role column of one user row.
const roleOf = (id: string): string | null =>
  (
    db.raw.query(`SELECT role FROM "user" WHERE id = ?`).get(id) as {
      role: string;
    } | null
  )?.role ?? null;

/** The pending code, or fail when none was minted. */
const pendingCode = async (): Promise<string> => {
  const ensured = await ensureSetupCode();

  expect(ensured._tag).toBe("Generated");

  if (ensured._tag !== "Generated") {
    throw new Error("expected a generated setup code");
  }

  return ensured.code;
};

describe("setup codes", () => {
  test("a minted code has five unambiguous groups (2^100 codes)", () => {
    expect(newSetupCode()).toMatch(/^(?:[A-Z2-9]{4}-){4}[A-Z2-9]{4}$/u);
    expect(newSetupCode()).not.toBe(newSetupCode());
  });

  test("pasted codes are normalised: case, spaces and dashes are ignored", () => {
    expect(normalizeSetupCode("abcd efgh-jklm npqr-stuv")).toBe(
      "ABCD-EFGH-JKLM-NPQR-STUV"
    );
  });

  test("the hash is stable hex, and different per code", async () => {
    const hash = await hashSetupCode(normalizeSetupCode("abcd efgh"));

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashSetupCode(normalizeSetupCode("abcd efgh"))).toBe(hash);
    expect(await hashSetupCode(normalizeSetupCode("wxyz 1234"))).not.toBe(hash);
  });
});

describe("ensure/check/consume/rotate", () => {
  test("the first issue mints, the second finds the pending row", async () => {
    publicBase();
    const first = await ensureSetupCode();

    expect(first._tag).toBe("Generated");
    expect(await ensureSetupCode()).toEqual({ _tag: "Pending" });
  });

  test("no code is minted once an admin exists", async () => {
    publicBase();
    addUser("owner", undefined, "admin");
    expect(await ensureSetupCode()).toEqual({ _tag: "Claimed" });
    expect(
      db.raw.query(`SELECT count(*) AS n FROM bootstrap_setup`).get()
    ).toEqual({ n: 0 });
  });

  test("a missing or blank code is refused as missing", async () => {
    publicBase();
    await pendingCode();
    expect(await checkSetupCode(ABSENT)).toBe("missing");
    expect(await checkSetupCode("   ")).toBe("missing");
  });

  test("an unknown code is refused, even with no code ever issued", async () => {
    publicBase();
    expect(await checkSetupCode("AAAA-AAAA-AAAA-AAAA-AAAA")).toBe("invalid");
  });

  test("a live code passes, and only once", async () => {
    publicBase();
    const code = await pendingCode();

    expect(await checkSetupCode(code.toLowerCase())).toBeNull();
    expect(await consumeSetupCode(code, "joiner")).toBe(true);
    expect(await checkSetupCode(code)).toBe("used");
  });

  test("only one of two racing accounts spends a code", async () => {
    publicBase();
    const code = await pendingCode();
    addUser("a");
    addUser("b");

    const [first, second] = await Promise.all([
      consumeSetupCode(code, "a"),
      consumeSetupCode(code, "b"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  test("rotation kills the old code and mints a fresh one", async () => {
    publicBase();
    const old = await pendingCode();
    const rotated = await rotateSetupCode();

    expect(rotated._tag).toBe("Generated");

    if (rotated._tag !== "Generated") {
      throw new Error("expected a rotated setup code");
    }

    expect(rotated.code).not.toBe(old);
    expect(await checkSetupCode(old)).toBe("invalid");
    expect(await checkSetupCode(rotated.code)).toBeNull();
  });

  test("rotation is refused once an admin exists", async () => {
    publicBase();
    addUser("owner", undefined, "admin");
    expect(await rotateSetupCode()).toEqual({ _tag: "Claimed" });
  });
});

describe("email anchor", () => {
  test("a stranger's first registration is refused and leaves no admin", async () => {
    publicBase("op@example.com");
    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("email");

    const proof = await checkFirstAdminProof(
      "stranger@example.com",
      undefined,
      policy
    );

    expect(proof).toEqual({
      _tag: "Refused",
      reason: "reserved",
    });
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("a stranger is refused even with a valid code", async () => {
    publicBase("op@example.com");
    const code = await pendingCode();
    const policy = await signupPolicy();

    // Knowing the address alone never suffices — and neither does holding a
    // code with the wrong address.
    expect(
      await checkFirstAdminProof("stranger@example.com", code, policy)
    ).toEqual({ _tag: "Refused", reason: "reserved" });
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("the named address without a code is refused", async () => {
    publicBase("op@example.com");
    await pendingCode();
    const policy = await signupPolicy();

    expect(
      await checkFirstAdminProof("op@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Refused", reason: "missing" });
  });

  test("the named address with a wrong code is refused", async () => {
    publicBase("op@example.com");
    await pendingCode();
    const policy = await signupPolicy();

    expect(
      await checkFirstAdminProof(
        "op@example.com",
        "AAAA-AAAA-AAAA-AAAA-AAAA",
        policy
      )
    ).toEqual({ _tag: "Refused", reason: "invalid" });
  });

  test("the named address with the code succeeds and becomes admin", async () => {
    publicBase("Op@Example.com");
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("op", "op@example.com");

    const proof = await checkFirstAdminProof("op@example.com", code, policy);

    expect(proof._tag).toBe("Admitted");

    const verdict = await claimFirstAdminSlot("op", code, policy);

    expect(verdict._tag).toBe("Admitted");
    expect(roleOf("op")).toBe("admin");
    expect(await checkSetupCode(code)).toBe("used");
  });

  test("two concurrent anchor registrations yield exactly one admin", async () => {
    // Same address in different cases: both pass the anchor check (it
    // lowercases), so the claim arbitrates — in production a second
    // identical email never reaches the claim (USER_ALREADY_EXISTS).
    publicBase("op@example.com");
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("a", "Op@Example.com");
    addUser("b", "op@example.com");

    const [a, b] = await Promise.all([
      claimFirstAdminSlot("a", code, policy),
      claimFirstAdminSlot("b", code, policy),
    ]);

    expect([a._tag, b._tag].filter((tag) => tag === "Admitted")).toHaveLength(
      1
    );

    // SAFETY: the projection is the one role column of each seeded account.
    const rows = db.raw
      .query(`SELECT id, role FROM "user" WHERE id IN ('a', 'b')`)
      .all() as { id: string; role: string | null }[];

    expect(rows.filter((row) => row.role === "admin")).toHaveLength(1);
    expect(await checkSetupCode(code)).toBe("used");
  });
});

describe("code bootstrap", () => {
  test("no code is refused and creates nobody", async () => {
    publicBase();
    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("code");
    expect(
      await checkFirstAdminProof("op@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Refused", reason: "missing" });
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("a wrong code is refused and creates nobody", async () => {
    publicBase();
    await pendingCode();
    const policy = await signupPolicy();

    expect(
      await checkFirstAdminProof(
        "op@example.com",
        "AAAA-AAAA-AAAA-AAAA-AAAA",
        policy
      )
    ).toEqual({ _tag: "Refused", reason: "invalid" });
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("the right code admits, makes admin, and spends the code", async () => {
    publicBase();
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("op", "op@example.com");

    expect(await checkFirstAdminProof("op@example.com", code, policy)).toEqual({
      _tag: "Admitted",
    });
    expect(await claimFirstAdminSlot("op", code, policy)).toEqual({
      _tag: "Admitted",
    });
    expect(roleOf("op")).toBe("admin");
    expect(await checkSetupCode(code)).toBe("used");
  });

  test("a second use of the code is refused", async () => {
    publicBase();
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("first", "first@example.com");

    expect(await claimFirstAdminSlot("first", code, policy)).toEqual({
      _tag: "Admitted",
    });

    const spent = await signupPolicy();

    expect(spent.setupMode).toBe("off");
    expect(await checkSetupCode(code)).toBe("used");
  });

  test("two concurrent claims spend one code on exactly one admin", async () => {
    publicBase();
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("a", "a@example.com");
    addUser("b", "b@example.com");

    const [a, b] = await Promise.all([
      (async () => {
        const proof = await checkFirstAdminProof("a@example.com", code, policy);

        return proof._tag === "Admitted"
          ? claimFirstAdminSlot("a", code, policy)
          : proof;
      })(),
      (async () => {
        const proof = await checkFirstAdminProof("b@example.com", code, policy);

        return proof._tag === "Admitted"
          ? claimFirstAdminSlot("b", code, policy)
          : proof;
      })(),
    ]);

    expect([a._tag, b._tag].filter((tag) => tag === "Admitted")).toHaveLength(
      1
    );

    // SAFETY: the projection is the one role column of each seeded account.
    const rows = db.raw
      .query(`SELECT id, role FROM "user" WHERE id IN ('a', 'b')`)
      .all() as { id: string; role: string | null }[];

    expect(rows.filter((row) => row.role === "admin")).toHaveLength(1);
    expect(await checkSetupCode(code)).toBe("used");
  });

  test("a rotation between proof and claim refuses without creating an admin", async () => {
    publicBase();
    const code = await pendingCode();
    const policy = await signupPolicy();

    expect(await checkFirstAdminProof("op@example.com", code, policy)).toEqual({
      _tag: "Admitted",
    });

    // The operator reissued in between: the checked hash is spent, so the
    // bound claim writes nothing.
    await rotateSetupCode();
    addUser("op", "op@example.com");

    expect(await claimFirstAdminSlot("op", code, policy)).toEqual({
      _tag: "Refused",
      reason: "used",
    });
    expect(roleOf("op")).toBe("user");
  });

  test("a consume failure after the claim still admits (and logs)", async () => {
    publicBase();
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("op", "op@example.com");
    // The banner stays loud in production; the assertion reads the call.
    const warned = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const verdict = await claimFirstAdminSlot("op", code, policy, () =>
        Promise.reject(new Error("db exploded"))
      );

      expect(verdict).toEqual({ _tag: "Admitted" });
      expect(roleOf("op")).toBe("admin");
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
  });

  test("a lost consume race after the claim still admits", async () => {
    publicBase();
    const code = await pendingCode();
    const policy = await signupPolicy();
    addUser("op", "op@example.com");

    const verdict = await claimFirstAdminSlot("op", code, policy, () =>
      Promise.resolve(false)
    );

    expect(verdict).toEqual({ _tag: "Admitted" });
    expect(roleOf("op")).toBe("admin");
  });
});

describe("localhost keeps today's behaviour", () => {
  test("anyone is admitted without a code, first account wins", async () => {
    // The dev platform provides the base (void.config.ts vars); without it
    // the gate fails closed, so the test states it explicitly.
    controlEnv.BASE_DOMAIN = "noite.localhost";
    const policy = await signupPolicy();

    expect(policy).toEqual({
      adminExists: false,
      firstRun: true,
      setupMode: "off",
      waitlistEnabled: false,
    });
    expect(
      await checkFirstAdminProof("anyone@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Admitted" });

    addUser("anyone", "anyone@example.com");
    expect(await claimFirstAdminSlot("anyone", ABSENT, policy)).toEqual({
      _tag: "Admitted",
    });
    expect(roleOf("anyone")).toBe("admin");
  });

  test("an anchor address does not gate a localhost base", async () => {
    controlEnv.BASE_DOMAIN = "noite.localhost";
    controlEnv.NOITE_ADMIN_EMAIL = "op@example.com";
    const policy = await signupPolicy();

    expect(policy.setupMode).toBe("off");
    expect(
      await checkFirstAdminProof("stranger@example.com", ABSENT, policy)
    ).toEqual({ _tag: "Admitted" });
  });
});

describe("signup policy", () => {
  test("a public base without an anchor requires the setup code", async () => {
    publicBase();
    expect(await signupPolicy()).toEqual({
      adminExists: false,
      firstRun: true,
      setupMode: "code",
      waitlistEnabled: false,
    });
  });

  test("a public base with an anchor reserves the slot by address", async () => {
    publicBase("op@example.com");
    expect(await signupPolicy()).toEqual({
      adminExists: false,
      firstRun: true,
      setupMode: "email",
      waitlistEnabled: false,
    });
  });

  test("any admin turns the bootstrap off, even on a public base", async () => {
    publicBase("op@example.com");
    addUser("owner", "owner@example.com", "admin");

    const policy = await signupPolicy();

    expect(policy.adminExists).toBe(true);
    expect(policy.setupMode).toBe("off");
    // Users exist, so uninvited registration is refused while the waitlist
    // is off — the bootstrap proof only matters while no admin exists.
    expect(policy.waitlistEnabled).toBe(false);
  });
});
