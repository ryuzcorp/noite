//! A template create resolves its id against the shipped list and hands the
//! runner one monorepo import: the templates repo URL with the template's
//! folder as `path`, squashed into a single commit. An unknown id fails
//! before any runner call, so a client can never point the import at
//! another URL.

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";

import * as Effect from "effect/Effect";

import { createTestD1 } from "../../testing/d1";
import { installRunnerMock } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { ensureDbPromise, setD1Binding } from "../db";
import { createAppForUser } from "./apps.server";

// The grant hits tables the test D1 does not migrate; the rollback path owns
// that coverage (apps-create.test.ts). Here it succeeds.
mock.module("../collaborators", () => ({
  grantCollaborator: () => Effect.void,
}));

/** The JSON-RPC params the create action sends for a template source. */
interface TemplateCreateParams {
  source: {
    actor: { name: string; userId: string };
    kind: string;
    path: string;
    ref: string;
    squash: boolean;
    url: string;
  };
}

let runner: RunnerMock;

beforeAll(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

beforeEach(() => {
  runner?.restore();
  runner = installRunnerMock([]);
});

afterAll(() => {
  runner.restore();
});

test("a template create imports its folder from the templates repo", async () => {
  const app = await createAppForUser({
    account: { id: "u-1", name: "One" },
    name: "Ilha + Void",
    slug: "ilha-void",
    source: { id: "ilha-void", kind: "template" },
  });

  expect(app.slug).toBe("ilha-void");
  expect(runner.calls).toEqual(["apps.create"]);

  // SAFETY: the mock records the params object the action sent.
  const params = runner.requests[0] as TemplateCreateParams;

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
