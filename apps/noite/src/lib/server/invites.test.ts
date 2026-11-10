import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { ensureDb, setD1Binding } from "../db";
import {
  claimBootstrapAdmin,
  checkInvite,
  consumeInvite,
  inviteLifecycle,
  listInvites,
  mintInvites,
  newInviteCode,
  normalizeInviteCode,
  revokeInvite,
  signupPolicy,
} from "./invites.server";

let db: TestD1;

/** A code that was never supplied (typed `string | undefined`). */
const ABSENT: string | undefined = [""][1];

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  db.raw.run(`DELETE FROM invite`);
  db.raw.run(`DELETE FROM "user"`);
});

const addUser = (id: string) => {
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    id,
    id,
    `${id}@example.com`,
  ]);
};

describe("codes", () => {
  test("a minted code has the XXXX-XXXX-XXXX shape", () => {
    expect(newInviteCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  });

  test("pasted codes are normalised: case, spaces and dashes are ignored", () => {
    expect(normalizeInviteCode("abcd efgh-jklm")).toBe("ABCD-EFGH-JKLM");
    expect(normalizeInviteCode(" abcdefghjklm ")).toBe("ABCD-EFGH-JKLM");
  });
});

describe("signup policy", () => {
  test("the first account bootstraps the instance; later ones need a code", async () => {
    const before = await signupPolicy();
    expect(before.firstRun).toBe(true);
    addUser("first");
    const policy = await signupPolicy();
    expect(policy.firstRun).toBe(false);
    expect(policy.requiresInvite).toBe(true);
  });
});

describe("checkInvite", () => {
  test("a missing or blank code is refused as missing", async () => {
    expect(await checkInvite(ABSENT)).toBe("missing");
    expect(await checkInvite("   ")).toBe("missing");
  });

  test("an unknown code is refused", async () => {
    expect(await checkInvite("AAAA-AAAA-AAAA")).toBe("unknown");
  });

  test("a live code passes — in one query", async () => {
    addUser("owner");
    const [code = ""] = await mintInvites("owner", 1);
    const before = db.executed.length;
    expect(await checkInvite(code.toLowerCase())).toBeNull();
    expect(db.executed.length - before).toBe(1);
  });

  test("used and revoked codes are refused with the right reason", async () => {
    addUser("owner");
    addUser("joiner");
    const [used = "", revoked = ""] = await mintInvites("owner", 2);
    expect(await consumeInvite(used, "joiner")).toBe(true);
    expect(await checkInvite(used)).toBe("used");

    // SAFETY: the code was minted above, so exactly one { id } row matches.
    const row = db.raw
      .query(`SELECT id FROM invite WHERE code = ?`)
      .get(revoked) as { id: string };

    await revokeInvite(row.id);
    expect(await checkInvite(revoked)).toBe("revoked");
  });
});

describe("consumeInvite", () => {
  test("only one of two racing accounts wins a code", async () => {
    addUser("owner");
    addUser("a");
    addUser("b");
    const [code = ""] = await mintInvites("owner", 1);

    const [first, second] = await Promise.all([
      consumeInvite(code, "a"),
      consumeInvite(code, "b"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  test("a revoked code cannot be claimed", async () => {
    addUser("owner");
    addUser("a");
    const [code = ""] = await mintInvites("owner", 1);
    db.raw.run(`UPDATE invite SET revoked = 1 WHERE code = ?`, [code]);
    expect(await consumeInvite(code, "a")).toBe(false);
  });
});

describe("bootstrap claim", () => {
  test("two concurrent first registrations cannot both become admin", async () => {
    // Both saw `firstRun` (an empty table) before either claimed; the claim is
    // the arbitration point, so exactly one wins and the other is an ordinary
    // account that the caller refuses.
    addUser("first");
    addUser("second");

    const [a, b] = await Promise.all([
      claimBootstrapAdmin("first"),
      claimBootstrapAdmin("second"),
    ]);

    expect([a._tag, b._tag].filter((tag) => tag === "Claimed")).toHaveLength(1);

    // SAFETY: the projection is the one role column of each seeded account.
    const rows = db.raw
      .query(`SELECT id, role FROM "user" WHERE id IN ('first', 'second')`)
      .all() as { id: string; role: string | null }[];

    expect(rows.filter((row) => row.role === "admin")).toHaveLength(1);
  });

  test("a single first account is claimed, and a second claim on it still reads claimed", async () => {
    addUser("only");

    const first = await claimBootstrapAdmin("only");
    const second = await claimBootstrapAdmin("only");

    expect(first._tag).toBe("Claimed");
    expect(second._tag).toBe("Claimed");
  });
});

describe("revoke: it reports what it did", () => {
  test("an available code is revoked", async () => {
    addUser("owner");
    const [code = ""] = await mintInvites("owner", 1);

    // SAFETY: the code was just minted, so one row matches.
    const row = db.raw
      .query(`SELECT id FROM invite WHERE code = ?`)
      .get(code) as { id: string };

    const revoked = await revokeInvite(row.id);

    expect(revoked._tag).toBe("Revoked");
    expect(await checkInvite(code)).toBe("revoked");
  });

  test("a spent code is refused instead of silently answering success", async () => {
    addUser("owner");
    addUser("joiner");
    const [code = ""] = await mintInvites("owner", 1);
    await consumeInvite(code, "joiner");

    // SAFETY: the code was just minted, so one row matches.
    const row = db.raw
      .query(`SELECT id FROM invite WHERE code = ?`)
      .get(code) as { id: string };

    const refused = await revokeInvite(row.id);

    expect(refused).toEqual({
      _tag: "Refused",
      reason: "used",
    });
  });

  test("an unknown id is refused as missing", async () => {
    const missing = await revokeInvite("no-such-id");

    expect(missing).toEqual({
      _tag: "Refused",
      reason: "missing",
    });
  });
});

describe("listInvites: the derived lifecycle", () => {
  test("a code whose redeemer was deleted still reads as used, never available", async () => {
    addUser("owner");
    addUser("joiner");
    const [code = ""] = await mintInvites("owner", 1);
    await consumeInvite(code, "joiner");

    // Deleting the account leaves `usedBy` behind (no FK on the column).
    db.raw.run(`DELETE FROM "user" WHERE id = 'joiner'`);

    const [view] = await listInvites();

    expect(view?.state).toBe("used");
    expect(view?.usedByEmail).toBe("");
    expect(view?.revoked).toBe(false);
  });

  test("used wins over revoked, whatever an operator toggles", () => {
    expect(
      inviteLifecycle({
        revoked: true,
        usedAt: "2026-11-01T00:00:00.000Z",
        usedBy: "u-1",
      })._tag
    ).toBe("Used");
    expect(
      inviteLifecycle({ revoked: true, usedAt: null, usedBy: null })._tag
    ).toBe("Revoked");
    expect(
      inviteLifecycle({ revoked: false, usedAt: null, usedBy: null })._tag
    ).toBe("Available");
  });
});
