import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { appListenPort, runnerCall } from "../e2e/helpers";

/** Prove the tree image serves the previous release's seed back: the app
 * row, its env var, its successful deploy, its verified domain, the D1 rows
 * the worker wrote, the R2 object, a live tenant response — and the
 * collaborator the control plane recorded. Reads the state file the seed
 * phase wrote (`UPGRADE_STATE`); every assertion hits the restarted stack. */
const STATE_PATH =
  process.env.UPGRADE_STATE ??
  `${process.env.E2E_AUTH_DIR ?? "upgrade/.auth"}/upgrade-state.json`;

interface UpgradeState {
  appId: string;
  deploySha: string;
  fileBody: string;
  hostname: string;
  inviteeEmail: string;
  marker: string;
  slug: string;
}

// SAFETY: the seed phase wrote this file as JSON in the shape above; a
// missing or corrupt file is a seed failure, not a passing verify. Read
// lazily: the seed phase imports this file (skipped) before the state exists.
const readState = (): UpgradeState =>
  JSON.parse(readFileSync(STATE_PATH, "utf-8")) as UpgradeState;

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
  // SAFETY: by-slug answers the app row (RunnerApp).
  const app = bySlug.body as { id?: string; slug?: string };
  expect(app.id).toBe(state.appId);
  expect(app.slug).toBe(state.slug);

  // The env var survived with its value.
  const env = await runnerCall(request, `/v1/apps/${state.appId}/env`);
  expect(env.status).toBe(200);
  // SAFETY: the env list answers AppEnv rows.
  const vars = env.body as { name?: string; value?: string }[];
  expect(
    vars.find((candidate) => candidate.name === "UPGRADE_MARKER")?.value
  ).toBe(state.marker);

  // The deploy history survived: the seeded revision is still a success.
  const deploys = await runnerCall(request, `/v1/apps/${state.appId}/deploys`);
  expect(deploys.status).toBe(200);
  // SAFETY: the deploy list answers deploy rows (RunnerDeploy).
  const rows = deploys.body as { sha?: string | null; status?: string }[];
  expect(
    rows.find((candidate) => candidate.sha === state.deploySha)?.status
  ).toBe("success");

  // The custom domain claim survived, still verified.
  const domains = await runnerCall(
    request,
    `/v1/apps/${state.appId}/domains?role=admin`
  );

  expect(domains.status).toBe(200);
  // SAFETY: the domain list answers claim rows with hostname + status.
  const claims = domains.body as { hostname?: string; status?: string }[];
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

  // SAFETY: the rows endpoint answers D1Rows (columns + rows + total).
  const visits = d1.body as {
    columns?: string[];
    rows?: (string | null)[][];
    total?: number;
  };

  expect(visits.total ?? 0).toBeGreaterThan(0);
  const urlColumn = (visits.columns ?? []).indexOf("url");
  expect(urlColumn).toBeGreaterThanOrEqual(0);
  expect(
    (visits.rows ?? []).some(
      (row) => row[urlColumn]?.includes(state.marker) ?? false
    )
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
  // SAFETY: the sample counter answers { n } on ?read=1 (verified ok above).
  const counter = (await probe.json()) as { n?: number };
  expect(counter.n).toEqual(expect.any(Number));

  // The collaborator the control plane recorded is still on the app.
  await page.goto(`/apps/${state.appId}/settings?section=collaborators`);
  await expect(page.getByText(state.inviteeEmail).first()).toBeVisible();
});
