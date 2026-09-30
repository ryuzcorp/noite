import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { ensureDbPromise, setD1Binding } from "./db";
import {
  checkInvite,
  consumeInvite,
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
  await ensureDbPromise();
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
