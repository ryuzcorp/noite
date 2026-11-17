import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import * as Schema from "effect/Schema";

import { appListenPort, gitRefs, runnerCall } from "../e2e/helpers";
import { hasCollaborator } from "./lane";

/** Prove the tree image serves the previous release's seed back: the app
 * row, its env var, its successful deploy, its verified domain, the D1 rows
 * the worker wrote, the R2 object, a live tenant response — and the
 * collaborator the control plane recorded. Reads the state file the seed
 * phase wrote (`UPGRADE_STATE`); every assertion hits the restarted stack.
 * The collaborator read goes through the control API, so no UI locator can
 * skew between the release that seeded and the tree that serves. */
const STATE_PATH =
  process.env.UPGRADE_STATE ??
  `${process.env.E2E_AUTH_DIR ?? "upgrade/.auth"}/upgrade-state.json`;

// The seed API key's sidecar (never in the printed state file): the lane
// keeps the state debug output keyless.
const KEY_PATH =
  process.env.UPGRADE_KEY ??
  nodePath.join(nodePath.dirname(STATE_PATH), "upgrade-api-key");

const UpgradeState = Schema.Struct({
  appId: Schema.String,
  deploySha: Schema.String,
  fileBody: Schema.String,
  hostname: Schema.String,
  inviteeEmail: Schema.String,
  marker: Schema.String,
  slug: Schema.String,
});

const AppRow = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
});

const EnvRow = Schema.Struct({ name: Schema.String, value: Schema.String });

const DeployRow = Schema.Struct({
  sha: Schema.NullOr(Schema.String),
  status: Schema.String,
});

const DomainRow = Schema.Struct({
  hostname: Schema.String,
  status: Schema.String,
});

const D1Page = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  total: Schema.Number,
});

// The seed phase wrote this file as JSON in the shape above; a missing or
// corrupt file is a seed failure, not a passing verify. Read lazily: the
// seed phase imports this file (skipped) before the state exists.
const readState = (): Schema.Schema.Type<typeof UpgradeState> =>
  Schema.decodeUnknownSync(UpgradeState)(
    JSON.parse(readFileSync(STATE_PATH, "utf-8"))
  );

// The lane runs this file twice; it only verifies after the restart.
test.skip(
  process.env.UPGRADE_PHASE !== "verify",
  "verify runs in the verify phase only"
);

test("the tree image serves the previous release's data back", async ({
  page,
  request,
}) => {
  const state = readState();

  // The app row survived under the same id and slug.
  const bySlug = await runnerCall(request, `/v1/apps/by-slug/${state.slug}`);
  expect(bySlug.status).toBe(200);
  const app = Schema.decodeUnknownSync(AppRow)(bySlug.body);
  expect(app.id).toBe(state.appId);
  expect(app.slug).toBe(state.slug);

  // The env var survived with its value.
  const env = await runnerCall(request, `/v1/apps/${state.appId}/env`);
  expect(env.status).toBe(200);
  const vars = Schema.decodeUnknownSync(Schema.Array(EnvRow))(env.body);
  expect(
    vars.find((candidate) => candidate.name === "UPGRADE_MARKER")?.value
  ).toBe(state.marker);

  // The deploy history survived: the seeded revision is still a success.
  const deploys = await runnerCall(request, `/v1/apps/${state.appId}/deploys`);
  expect(deploys.status).toBe(200);
  const rows = Schema.decodeUnknownSync(Schema.Array(DeployRow))(deploys.body);
  expect(
    rows.find((candidate) => candidate.sha === state.deploySha)?.status
  ).toBe("success");

  // The custom domain claim survived, still verified.
  const domains = await runnerCall(
    request,
    `/v1/apps/${state.appId}/domains?role=admin`
  );

  expect(domains.status).toBe(200);

  const claims = Schema.decodeUnknownSync(Schema.Array(DomainRow))(
    domains.body
  );

  expect(
    claims.find((candidate) => candidate.hostname === state.hostname)?.status
  ).toBe("verified");

  // The D1 rows the worker wrote before the restart are still there: the
  // visits row whose URL carries the marker.
  const d1 = await runnerCall(
    request,
    `/v1/apps/${state.appId}/storage/d1/demo/tables/visits/rows`,
    { body: {}, method: "POST" }
  );

  expect(d1.status).toBe(200);
  const visits = Schema.decodeUnknownSync(D1Page)(d1.body);
  expect(visits.total).toBeGreaterThan(0);
  const urlColumn = visits.columns.indexOf("url");
  expect(urlColumn).toBeGreaterThanOrEqual(0);
  expect(
    visits.rows.some((row) => row[urlColumn]?.includes(state.marker) ?? false)
  ).toBe(true);

  // The tenant serves: the R2 object reads back byte-identical, and the
  // worker answers (read-only probe, never advancing the counter).
  const port = await appListenPort(request, state.appId);

  const file = await request.get(
    `http://localhost:${port}/files/upgrade-marker.txt`
  );

  expect(file.ok()).toBe(true);
  expect(await file.text()).toBe(state.fileBody);

  const probe = await request.get(`http://localhost:${port}/?read=1`);
  expect(probe.ok()).toBe(true);

  const counter = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))(
    await probe.json()
  );

  expect(counter.n).toEqual(expect.any(Number));

  // The seed's API key still authenticates git: the credential store and
  // the git mirror survived the upgrade, and the seed push's commit is
  // still the tip. The key comes from its sidecar file, never the printed
  // state.
  expect(gitRefs(readFileSync(KEY_PATH, "utf-8").trim(), state.slug)).toContain(
    state.deploySha
  );

  // The collaborator the control plane recorded is still on the app.
  expect(await hasCollaborator(page, state.appId, state.inviteeEmail)).toBe(
    true
  );

  // The lane's auth is intact too: the session the seed registered still
  // answers, so the restart kept the control plane's own data as well.
  const sessionRes = await page.request.get("/api/auth/get-session");
  expect(sessionRes.ok()).toBe(true);

  const session = Schema.decodeUnknownSync(
    Schema.Struct({ user: Schema.Struct({ email: Schema.String }) })
  )(await sessionRes.json());

  expect(session.user.email).toBe("e2e@noite.local");
});
