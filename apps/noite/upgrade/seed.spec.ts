import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  pushAppDir,
  registerInviteeWithFreshCode,
  runnerCall,
} from "../e2e/helpers";

/** Seed the upgrade lane: create an app with an env var, deploy the sample
 * worker, write tenant state (R2 + D1, both through the worker itself),
 * claim a custom domain, and add a collaborator — then record everything
 * the verify phase re-reads in the state file (`UPGRADE_STATE`, default
 * under the lane's test dir). Runs once, against the previous release's
 * image; the tree image must serve all of this back after the restart. */
const SLUG = `upgrade-${Date.now()}`;
const MARKER = randomUUID();
const FILE_BODY = `upgrade-lane ${MARKER}\n`;
const INVITEE_EMAIL = `upgrade-collab-${Date.now()}@example.com`;

const STATE_PATH =
  process.env.UPGRADE_STATE ??
  `${process.env.E2E_AUTH_DIR ?? "upgrade/.auth"}/upgrade-state.json`;

const tenant = (port: number): string => `http://localhost:${port}`;

// The lane runs this file twice (seed against the old image, verify against
// the new one); it only seeds in its own phase.
test.skip(
  process.env.UPGRADE_PHASE === "verify",
  "seed runs in the seed phase only"
);

test("seed the previous release with app, env, deploy, domain and people", async ({
  browser,
  page,
  request,
}) => {
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Upgrade Lane",
    slug: SLUG,
  });

  try {
    // An env var through the runner API (the deploy merges it into the
    // worker's vars; the verify phase reads it back from the database).
    const setEnv = await runnerCall(request, `/v1/apps/${appId}/env`, {
      body: { name: "UPGRADE_MARKER", value: MARKER },
      method: "POST",
    });

    expect(setEnv.status).toBe(200);

    // The sample worker: D1 `demo`, R2 `uploads`, the Counter object.
    const sha = pushAppDir(apiKey, new URL("../test", import.meta.url), SLUG);

    // Poll the pushed revision's own row (never a clock): the deploy takes
    // minutes (bun install + celld deploy + fleet boot).
    let deployStatus = "";
    let deploySha: string | null = null;
    await expect
      .poll(
        async () => {
          const deploys = await runnerCall(
            request,
            `/v1/apps/${appId}/deploys`
          );

          // SAFETY: the runner's deploy list answers deploy rows (RunnerDeploy).
          const rows = deploys.body as {
            sha?: string | null;
            status?: string;
          }[];

          const row = rows.find((candidate) => candidate.sha === sha);
          deployStatus = row?.status ?? "no-row";
          deploySha = row?.sha ?? null;

          return deployStatus;
        },
        { intervals: [2000], timeout: 8 * 60_000 }
      )
      .toBe("success");
    expect(deploySha).toBe(sha);

    const port = await appListenPort(request, appId);

    // Tenant state through the worker itself: an R2 object plus the D1
    // `visits` row every request writes (the row's URL carries the marker).
    const put = await request.put(`${tenant(port)}/files/upgrade-marker.txt`, {
      data: FILE_BODY,
    });

    expect(put.ok()).toBe(true);
    const hit = await request.get(`${tenant(port)}/?marker=${MARKER}`);
    expect(hit.ok()).toBe(true);

    const back = await request.get(`${tenant(port)}/files/upgrade-marker.txt`);

    expect(back.ok()).toBe(true);
    expect(await back.text()).toBe(FILE_BODY);
    const probe = await request.get(`${tenant(port)}/?read=1`);
    expect(probe.ok()).toBe(true);

    // A custom domain claim (born verified on the single-tenancy lane).
    const hostname = `${SLUG}.example.com`;

    const claim = await runnerCall(
      request,
      `/v1/apps/${appId}/domains?role=admin`,
      {
        body: { hostname },
        method: "POST",
      }
    );

    expect(claim.status).toBe(200);

    // A collaborator: register a second account, invite it as a viewer, and
    // prove the grant by opening the app in its session.
    const invitee = await registerInviteeWithFreshCode(browser, page, {
      email: INVITEE_EMAIL,
      name: "Upgrade Collab",
    });

    try {
      await page.goto(`/apps/${appId}/settings?section=collaborators`);
      await page.getByRole("button", { exact: true, name: "Invite" }).click();
      await page.locator("#invite-email").fill(INVITEE_EMAIL);
      await page.locator("#invite-role").selectOption("view");
      await page
        .getByRole("dialog")
        .getByRole("button", { exact: true, name: "Invite" })
        .click();
      await expect(page.getByText(INVITEE_EMAIL).first()).toBeVisible();

      await invitee.page.goto("/apps");
      await invitee.page
        .getByRole("button", { exact: true, name: "Accept" })
        .click();
      await expect(invitee.page).toHaveURL(new RegExp(`/apps/${appId}`, "u"));
    } finally {
      await invitee.context.close();
    }

    const state = {
      appId,
      deploySha: sha,
      fileBody: FILE_BODY,
      hostname,
      inviteeEmail: INVITEE_EMAIL,
      marker: MARKER,
      slug: SLUG,
    };

    mkdirSync(nodePath.dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    await runnerCall(request, `/v1/apps/${appId}`, { method: "DELETE" });
    throw error;
  }
});
