import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { installRunnerMock, makeApp } from "../testing/runner-mock";
import type { RunnerMock } from "../testing/runner-mock";
import {
  acceptPendingInvite,
  declinePendingInvite,
  dropAppCollaborators,
  grantCollaborator,
  listAppsForCollaborator,
  listCollaboratorRows,
  listInvitesForEmail,
  listPendingInvites,
  requireAppRole,
  requireAppRoleBySlug,
  revokePendingInvite,
  upsertPendingInvite,
} from "./collaborators";
import { ensureDb, setD1Binding } from "./db";

let db: TestD1;
let runner: RunnerMock;

const APP = makeApp({ id: "app-1", slug: "app-one", userId: "u-creator" });
const OTHER = makeApp({ id: "app-2", name: "Two", slug: "two", userId: "u-x" });

const addUser = (id: string, email: string, role = "user", name = id) => {
  db.raw.run(`INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, ?)`, [
    id,
    name,
    email,
    role,
  ]);
};

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  db.raw.run(`DELETE FROM app_collaborator`);
  db.raw.run(`DELETE FROM collaborator_invite`);
  db.raw.run(`DELETE FROM "user"`);
  addUser("u-creator", "creator@example.com");
  addUser("u-view", "view@example.com");
  addUser("u-push", "push@example.com");
  addUser("u-admin", "root@example.com", "admin");
  addUser("u-stranger", "stranger@example.com");
  runner?.restore();
  runner = installRunnerMock([APP, OTHER]);
});

afterAll(() => {
  runner.restore();
});

/** The role a passing gate resolved to. */
const roleOf = async (
  gate: ReturnType<typeof requireAppRole>
): Promise<string> => {
  const access = await gate;

  return access.role;
};

const denied = async (work: Promise<unknown>) => {
  let failed = false;

  try {
    await work;
  } catch {
    failed = true;
  }

  return failed;
};

describe("access gate", () => {
  test("a grant decides the role, in order view < push < admin", async () => {
    await grantCollaborator(APP.id, "u-view", "view");
    await grantCollaborator(APP.id, "u-push", "push");
    expect(await roleOf(requireAppRole(APP.id, "u-view", "view"))).toBe("view");
    expect(await denied(requireAppRole(APP.id, "u-view", "push"))).toBe(true);
    expect(await roleOf(requireAppRole(APP.id, "u-push", "push"))).toBe("push");
    expect(await denied(requireAppRole(APP.id, "u-push", "admin"))).toBe(true);
  });

  test("a stranger has no access, and an unknown app is denied too", async () => {
    expect(await denied(requireAppRole(APP.id, "u-stranger", "view"))).toBe(
      true
    );
    expect(await denied(requireAppRole("nope", "u-creator", "view"))).toBe(
      true
    );
  });

  test("the creator holds no access beyond their grant, so removal sticks", async () => {
    // Regression: a "creator fallback" in the gate re-created the admin grant
    // on the next request, making the creator impossible to remove.
    expect(await denied(requireAppRole(APP.id, "u-creator", "view"))).toBe(
      true
    );
    await grantCollaborator(APP.id, "u-creator", "admin");
    expect(await roleOf(requireAppRole(APP.id, "u-creator", "admin"))).toBe(
      "admin"
    );
    db.raw.run(`DELETE FROM app_collaborator WHERE userId = 'u-creator'`);
    expect(await denied(requireAppRole(APP.id, "u-creator", "view"))).toBe(
      true
    );

    // SAFETY: a COUNT query always yields one { n } row.
    const rows = db.raw
      .query(`SELECT count(*) AS n FROM app_collaborator WHERE userId = ?`)
      .get("u-creator") as { n: number };

    expect(rows.n).toBe(0);
  });

  test("an instance admin manages every app without a grant", async () => {
    expect(await roleOf(requireAppRole(OTHER.id, "u-admin", "admin"))).toBe(
      "admin"
    );
  });

  test("slug lookup is one runner GET, never the full app list", async () => {
    await grantCollaborator(APP.id, "u-view", "view");
    runner.calls.length = 0;
    const access = await requireAppRoleBySlug("app-one", "u-view", "view");
    expect(access.app.id).toBe(APP.id);
    expect(runner.calls).toEqual(["apps.get_by_slug"]);
    expect(
      await denied(requireAppRoleBySlug("missing", "u-view", "view"))
    ).toBe(true);
  });
});

describe("listAppsForCollaborator", () => {
  test("heals an app whose creator grant never landed", async () => {
    // The create RPC outlived the control plane's bound, so APP exists with
    // no grant at all: nobody can see or delete it.
    expect(await listCollaboratorRows(APP.id)).toHaveLength(0);

    const apps = await listAppsForCollaborator("u-creator");

    expect(apps.map((app) => app.id)).toEqual([APP.id]);
    const rows = await listCollaboratorRows(APP.id);
    expect(rows.map((row) => [row.userId, row.role])).toEqual([
      ["u-creator", "admin"],
    ]);
    // Healed once: the grant is not duplicated on the next list.
    await listAppsForCollaborator("u-creator");
    expect(await listCollaboratorRows(APP.id)).toHaveLength(1);
  });

  test("lists granted apps and never resurrects a revoked creator", async () => {
    await grantCollaborator(OTHER.id, "u-creator", "view");
    // A revoked creator still leaves this admin grant, so the app is not
    // grantless and the heal above must not re-add the creator.
    await grantCollaborator(APP.id, "u-view", "admin");

    const apps = await listAppsForCollaborator("u-creator");

    expect(apps.map((app) => app.id)).toEqual([OTHER.id]);
    const rows = await listCollaboratorRows(APP.id);
    expect(rows.map((row) => row.userId)).toEqual(["u-view"]);
  });
});

describe("listCollaboratorRows", () => {
  test("returns every grant with its account in a single query", async () => {
    await grantCollaborator(APP.id, "u-push", "push");
    await grantCollaborator(APP.id, "u-view", "view");
    await grantCollaborator(OTHER.id, "u-stranger", "admin");
    const before = db.executed.length;
    const rows = await listCollaboratorRows(APP.id);
    expect(db.executed.length - before).toBe(1);
    expect(rows.map((row) => [row.email, row.role])).toEqual([
      ["push@example.com", "push"],
      ["view@example.com", "view"],
    ]);
  });

  test("keeps a grant whose account row is gone", async () => {
    db.raw.run(`PRAGMA foreign_keys = OFF`);
    db.raw.run(
      `INSERT INTO app_collaborator (id, appId, userId, role) VALUES ('g', ?, 'ghost', 'view')`,
      [APP.id]
    );
    db.raw.run(`PRAGMA foreign_keys = ON`);
    const rows = await listCollaboratorRows(APP.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("");
  });
});

const invite = (email: string, role: "view" | "push" | "admin" = "view") =>
  upsertPendingInvite({
    appId: APP.id,
    appName: APP.name,
    email,
    invitedBy: "u-creator",
    role,
  });

describe("pending invitations", () => {
  test("inviting grants nothing until it is accepted", async () => {
    await invite("Stranger@Example.com");
    expect(await denied(requireAppRole(APP.id, "u-stranger", "view"))).toBe(
      true
    );
    const waiting = await listInvitesForEmail("stranger@example.com");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.appName).toBe(APP.name);
  });

  test("the same email is one invitation; a re-invite changes the role", async () => {
    await invite("stranger@example.com", "view");
    await invite("STRANGER@example.com", "push");
    const pending = await listPendingInvites(APP.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.role).toBe("push");
  });

  test("an invitation can be accepted only by the address it names", async () => {
    await invite("stranger@example.com", "push");
    const [pending] = await listPendingInvites(APP.id);
    const id = pending?.id ?? "";
    // Someone else holding the id gets nothing.
    expect(await acceptPendingInvite(id, "view@example.com", "u-view")).toEqual(
      { _tag: "NotFound" }
    );
    expect(await denied(requireAppRole(APP.id, "u-view", "view"))).toBe(true);
    // The addressee joins with the invited role, and it is consumed.
    expect(
      await acceptPendingInvite(id, "Stranger@example.com", "u-stranger")
    ).toEqual({ _tag: "Accepted", appId: APP.id, role: "push" });
    expect(await roleOf(requireAppRole(APP.id, "u-stranger", "push"))).toBe(
      "push"
    );
    expect(await listPendingInvites(APP.id)).toHaveLength(0);
    expect(
      await acceptPendingInvite(id, "stranger@example.com", "u-stranger")
    ).toEqual({ _tag: "NotFound" });
  });

  test("accepting replaces an existing grant with the invited role", async () => {
    await grantCollaborator(APP.id, "u-view", "view");
    await invite("view@example.com", "admin");
    const [pending] = await listPendingInvites(APP.id);
    await acceptPendingInvite(pending?.id ?? "", "view@example.com", "u-view");
    expect(await roleOf(requireAppRole(APP.id, "u-view", "admin"))).toBe(
      "admin"
    );
    const rows = await listCollaboratorRows(APP.id);
    expect(rows.filter((row) => row.userId === "u-view")).toHaveLength(1);
  });

  test("decline and revoke delete only what they should", async () => {
    await invite("stranger@example.com");
    await invite("view@example.com");
    const pending = await listPendingInvites(APP.id);

    const strangerInvite = pending.find(
      (p) => p.email === "stranger@example.com"
    );

    const viewInvite = pending.find((p) => p.email === "view@example.com");
    // Declining someone else's invitation is a no-op.
    await declinePendingInvite(strangerInvite?.id ?? "", "view@example.com");
    expect(await listPendingInvites(APP.id)).toHaveLength(2);
    await declinePendingInvite(
      strangerInvite?.id ?? "",
      "stranger@example.com"
    );
    // Revoking through the wrong app is a no-op.
    await revokePendingInvite(OTHER.id, viewInvite?.id ?? "");
    expect(await listPendingInvites(APP.id)).toHaveLength(1);
    await revokePendingInvite(APP.id, viewInvite?.id ?? "");
    expect(await listPendingInvites(APP.id)).toHaveLength(0);
  });

  test("dropping an app's collaborators drops its invitations too", async () => {
    await grantCollaborator(APP.id, "u-view", "view");
    await invite("stranger@example.com");
    await dropAppCollaborators(APP.id);
    expect(await listCollaboratorRows(APP.id)).toHaveLength(0);
    expect(await listPendingInvites(APP.id)).toHaveLength(0);
  });
});
