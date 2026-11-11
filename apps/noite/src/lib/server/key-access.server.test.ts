import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { installRunnerMock, makeApp } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { grantCollaborator, removeGrant } from "../collaborators";
import { ensureDb, setD1Binding } from "../db";
import { ACCOUNT_WIDE } from "../key-principal";
import type { KeyPrincipal, KeyScope } from "../key-principal";
import { keyAppVerdict } from "./key-access.server";

let db: TestD1;
let runner: RunnerMock;

const APP = makeApp({ id: "app-1", slug: "app-one", userId: "u-owner" });

const OTHER = makeApp({
  id: "app-2",
  name: "Two",
  slug: "two",
  userId: "u-stranger",
});

const addUser = (id: string, email: string, role = "user") => {
  db.raw.run(`INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, ?)`, [
    id,
    id,
    email,
    role,
  ]);
};

const principal = (
  scope: Partial<KeyScope> = {},
  expiresAt: Date | null = null
): KeyPrincipal => ({
  expiresAt,
  keyId: "key-1",
  keyName: "ci",
  scope: { ...ACCOUNT_WIDE, ...scope },
  userId: "u-push",
});

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  db.raw.run(`DELETE FROM app_collaborator`);
  db.raw.run(`DELETE FROM "user"`);
  addUser("u-owner", "owner@example.com");
  addUser("u-push", "push@example.com");
  addUser("u-admin", "admin@example.com");
  db.raw.run(
    `INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, 'admin')`,
    ["u-root", "u-root", "root@example.com"]
  );
  runner?.restore();
  runner = installRunnerMock([APP, OTHER]);
});

afterAll(() => {
  runner.restore();
});

describe("keyAppVerdict", () => {
  test("an app-scoped key is granted on its app and refused on another", async () => {
    await grantCollaborator("app-1", "u-push", "push");
    await grantCollaborator("app-2", "u-push", "push");

    const key = principal({ appIds: ["app-1"] });

    // By slug, by id and by the other app's slug: all three resolve the same
    // set check against the app row's id.
    const verdicts = await Promise.all([
      keyAppVerdict(key, { slug: "app-one" }, "push"),
      keyAppVerdict(key, { id: "app-1" }, "view"),
      keyAppVerdict(key, { slug: "two" }, "view"),
      keyAppVerdict(key, { id: "app-2" }, "view"),
    ]);

    expect(verdicts.map((verdict) => verdict._tag)).toEqual([
      "Granted",
      "Granted",
      "OutsideScope",
      "OutsideScope",
    ]);
  });

  test("a slug that names another app never resolves to the key's app", async () => {
    await grantCollaborator("app-2", "u-push", "push");
    await grantCollaborator("app-1", "u-push", "push");

    // Key limited to app-2: calling app-1's slug must not fall back to an id
    // lookup that lands on app-2 (the two are different apps).
    const verdict = await keyAppVerdict(
      principal({ appIds: ["app-2"] }),
      { slug: "app-one" },
      "view"
    );

    expect(verdict._tag).toBe("OutsideScope");
  });

  test("a renamed app stays covered: the restriction is the id", async () => {
    await grantCollaborator("app-1", "u-push", "push");
    const key = principal({ appIds: ["app-1"] });

    const before = await keyAppVerdict(key, { slug: "app-one" }, "push");
    expect(before._tag).toBe("Granted");

    const row = runner.apps.find((app) => app.id === "app-1");

    if (!row) {
      throw new Error("the fixture app vanished");
    }

    row.slug = "renamed";
    row.subdomain = "renamed.noite.localhost";

    const renamedVerdicts = await Promise.all([
      keyAppVerdict(key, { slug: "renamed" }, "push"),
      keyAppVerdict(key, { id: "app-1" }, "push"),
    ]);

    expect(renamedVerdicts.map((verdict) => verdict._tag)).toEqual([
      "Granted",
      "Granted",
    ]);
  });

  test("an app deleted after the key was minted is gone", async () => {
    await grantCollaborator("app-1", "u-push", "push");
    runner.apps = runner.apps.filter((app) => app.id !== "app-1");

    const verdict = await keyAppVerdict(
      principal({ appIds: ["app-1"] }),
      { id: "app-1" },
      "view"
    );

    expect(verdict._tag).toBe("NoAccess");
  });

  test("a removed collaborator loses access while the key still exists", async () => {
    await grantCollaborator("app-1", "u-push", "push");
    const key = principal();

    const before = await keyAppVerdict(key, { id: "app-1" }, "push");
    expect(before._tag).toBe("Granted");

    await removeGrant("app-1", "u-push");

    const after = await keyAppVerdict(key, { id: "app-1" }, "push");
    expect(after._tag).toBe("NoAccess");
  });

  test("an expired key is refused before the app is even resolved", async () => {
    await grantCollaborator("app-1", "u-push", "push");
    const before = runner.calls.length;

    const verdict = await keyAppVerdict(
      principal({}, new Date("2020-01-01T00:00:00Z")),
      { id: "app-1" },
      "view"
    );

    expect(verdict._tag).toBe("Expired");
    // No runner round trip: the expiry is decided from the principal alone.
    expect(runner.calls.length).toBe(before);
  });

  test("a push ceiling caps an admin's role", async () => {
    await grantCollaborator("app-1", "u-root", "admin");

    const verdict = await keyAppVerdict(
      { ...principal({ roleCeiling: "push" }), userId: "u-root" },
      { id: "app-1" },
      "admin"
    );

    expect(verdict._tag).toBe("BelowCeiling");
    expect(verdict._tag === "BelowCeiling" ? verdict.role : null).toBe("push");

    const allowed = await keyAppVerdict(
      { ...principal({ roleCeiling: "push" }), userId: "u-root" },
      { id: "app-1" },
      "push"
    );

    expect(allowed._tag).toBe("Granted");
    expect(allowed._tag === "Granted" ? allowed.role : null).toBe("push");
  });

  test("the owner's role caps a wider ceiling", async () => {
    await grantCollaborator("app-1", "u-push", "push");

    const verdict = await keyAppVerdict(
      principal({ roleCeiling: "admin" }),
      { id: "app-1" },
      "admin"
    );

    expect(verdict._tag).toBe("BelowCeiling");
  });
});
