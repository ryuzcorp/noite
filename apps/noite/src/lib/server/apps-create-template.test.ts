//! A template create resolves its id against the shipped list and hands the
//! runner one monorepo import: the templates repo URL with the template's
//! folder as `path`, squashed into a single commit. An unknown id fails
//! before any runner call, so a client can never point the import at
//! another URL.

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";

import * as Schema from "effect/Schema";

import { createTestD1 } from "../../testing/d1";
import { installRunnerMock, makeApp } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { ensureDb, setD1Binding } from "../db";
import { createAppForUser } from "./apps.server";

// The grant hits tables the test D1 does not migrate; the rollback path owns
// that coverage (apps-create.test.ts). Here it succeeds.
mock.module("../collaborators", () => ({
  grantCollaborator: () => Promise.resolve("applied" as const),
}));

/** The request body the create action sends for a template source. */
const TemplateCreateParams = Schema.Struct({
  source: Schema.Struct({
    actor: Schema.Struct({ name: Schema.String, userId: Schema.String }),
    kind: Schema.String,
    path: Schema.String,
    ref: Schema.String,
    squash: Schema.Boolean,
    url: Schema.String,
  }),
});

let runner: RunnerMock;

beforeAll(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  runner?.restore();
  runner = installRunnerMock([]);
});

afterAll(() => {
  runner.restore();
  // The collaborator module is mocked for this file only: another test file
  // that writes real grants must not inherit the double.
  mock.restore();
});

test("a template create imports its folder from the templates repo", async () => {
  const app = await createAppForUser({
    account: { id: "u-1", name: "One" },
    name: "Ilha + Void",
    slug: "ilha-void",
    source: { id: "ilha-void", kind: "template" },
  });

  expect(app.slug).toBe("ilha-void");
  expect(runner.calls).toEqual(["POST /v1/apps"]);

  // SAFETY: the mock records the request body object the action sent; this
  // schema is the shape the test reads back at the boundary.
  const params = Schema.decodeUnknownSync(TemplateCreateParams)(
    runner.requests[0]
  );

  expect(params.source).toEqual({
    actor: { name: "One", userId: "u-1" },
    kind: "git",
    path: "templates/ilha-void",
    ref: "main",
    squash: true,
    url: "https://github.com/ryuzcorp/noite-templates",
  });
});

test("an unknown template id fails before any runner call", async () => {
  await expect(
    createAppForUser({
      account: { id: "u-1", name: "One" },
      name: "Bogus",
      slug: "bogus",
      source: { id: "nope", kind: "template" },
    })
  ).rejects.toThrow("Unknown template: nope");
  expect(runner.calls).toEqual([]);
});

test("a retry recovers an app whose create outlived the call bound", async () => {
  runner.apps.push(
    makeApp({
      createdAt: new Date().toISOString(),
      id: "app-9",
      name: "Taken",
      slug: "taken",
      userId: "u-1",
    })
  );

  const app = await createAppForUser({
    account: { id: "u-1", name: "One" },
    name: "Taken",
    slug: "taken",
  });

  expect(app.id).toBe("app-9");
  expect(runner.calls).toEqual(["POST /v1/apps", "GET /v1/apps/by-slug/taken"]);
});

test("a retry on another account's slug still fails", async () => {
  runner.apps.push(
    makeApp({ id: "app-9", name: "Taken", slug: "taken", userId: "u-2" })
  );

  await expect(
    createAppForUser({
      account: { id: "u-1", name: "One" },
      name: "Taken",
      slug: "taken",
    })
  ).rejects.toThrow(/slug already taken/u);
  expect(runner.calls).toEqual(["POST /v1/apps", "GET /v1/apps/by-slug/taken"]);
});
