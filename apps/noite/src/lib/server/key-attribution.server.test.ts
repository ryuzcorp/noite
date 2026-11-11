import { beforeAll, describe, expect, test } from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { ensureDb, setD1Binding } from "../db";
import { ACCOUNT_WIDE } from "../key-principal";
import type { KeyPrincipal } from "../key-principal";
import { keyActor, userDisplayName } from "./key-attribution.server";

let db: TestD1;

const principal = (keyName = "ci"): KeyPrincipal => ({
  expiresAt: null,
  keyId: "key-1",
  keyName,
  scope: ACCOUNT_WIDE,
  userId: "u-1",
});

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
  db.raw.run(
    `INSERT INTO "user" (id, name, email) VALUES ('u-1', 'Ada', 'ada@example.com')`
  );
  db.raw.run(
    `INSERT INTO "user" (id, name, email) VALUES ('u-2', '  ', 'b@example.com')`
  );
});

describe("keyActor", () => {
  test("names the key in the commit identity", async () => {
    expect(await keyActor(principal())).toEqual({
      name: "Ada via key ci",
      userId: "u-1",
    });
  });

  test("a key with no label is just the account", async () => {
    const actor = await keyActor(principal(""));

    expect(actor.name).toBe("Ada");
  });

  test("an account with no display name still reads as a person", async () => {
    expect(await keyActor({ ...principal("nightly"), userId: "u-2" })).toEqual({
      name: "Noite user via key nightly",
      userId: "u-2",
    });
  });

  test("a vanished account is attributed, not dropped", async () => {
    const actor = await keyActor({ ...principal(), userId: "gone" });

    expect(actor.name).toBe("Noite user via key ci");
    expect(await userDisplayName("gone")).toBe("");
  });
});
