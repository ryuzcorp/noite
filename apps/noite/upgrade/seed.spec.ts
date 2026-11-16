import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import * as Schema from "effect/Schema";

import { appListenPort, pushAppDir, runnerCall } from "../e2e/helpers";
import {
  OWNER,
  acceptInvitation,
  createApp,
  inviteCollaborator,
  mintKey,
  pendingInvitationId,
  readInviteCodeApi,
  registerAccount,
} from "./lane";

/** Seed the upgrade lane without touching version-skewed UI: after the one
 * unavoidable passkey registration (see lane.ts), every step goes through
 * the stable `/api` actions and the runner's `/v1` API plus the sample
 * worker itself — never a DOM locator. The seed runs against the previous
 * release's image, so any UI the tree redesigns would otherwise break it.
 * Records everything the verify phase re-reads in the state file
 * (`UPGRADE_STATE`, default under the lane's auth dir). */
const SLUG = `upgrade-${Date.now()}`;
const MARKER = randomUUID();
const FILE_BODY = `upgrade-lane ${MARKER}\n`;
const INVITEE_EMAIL = `upgrade-collab-${Date.now()}@example.com`;

const STATE_PATH =
  process.env.UPGRADE_STATE ??
  `${process.env.E2E_AUTH_DIR ?? "upgrade/.auth"}/upgrade-state.json`;

const tenant = (port: number): string => `http://localhost:${port}`;

const DeployRow = Schema.Struct({
  sha: Schema.NullOr(Schema.String),
  status: Schema.String,
});

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
  // The setup project registered this session already; re-registering the
  // same address would fail as taken, so the seed reuses the fixture page
  // and registers only the second account below.
  const sessionRes = await page.request.get("/api/auth/get-session");

  const session = Schema.decodeUnknownSync(
    Schema.Struct({ user: Schema.Struct({ email: Schema.String }) })
  )(await sessionRes.json());

  if (session.user.email !== OWNER.email) {
    throw new Error("setup session missing: the setup project must run first");
  }

  const key = await mintKey(page, `${SLUG}-ci`);

  const appId = await createApp(page, {
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
    const sha = pushAppDir(key, new URL("../test", import.meta.url), SLUG);

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

          const rows = Schema.decodeUnknownSync(Schema.Array(DeployRow))(
            deploys.body
          );

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

    // A collaborator: register a second account, invite it as a viewer,
    // and prove the grant through the invitation it accepts.
    const inviteCode = await readInviteCodeApi(page);

    const invitee = await registerAccount(browser, {
      email: INVITEE_EMAIL,
      inviteCode,
      name: "Upgrade Collab",
    });

    try {
      expect(
        await inviteCollaborator(page, {
          appId,
          email: INVITEE_EMAIL,
          role: "view",
        })
      ).toBe("invited");

      const inviteId = await pendingInvitationId(invitee.page, appId);

      expect(await acceptInvitation(invitee.page, inviteId)).toBe(appId);
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
