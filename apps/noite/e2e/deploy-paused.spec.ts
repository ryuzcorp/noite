import { readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerApi,
  waitForDeploy,
} from "./helpers";

const SLUG = "paused";

/** The app this spec creates is dropped afterwards: the account's app quota
 * (10) is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

/** The app row as the runner answers it, narrowed to what this spec reads. */
interface AppRow {
  autoDeploy: {
    state: "eligible" | "failing" | "exhausted" | "stopped";
    sha?: string;
    failures?: number;
  };
}

interface DeployRow {
  sha: string | null;
  status: string;
}

/** A revision whose build fails: the noite sample with a `build` script that
 * exits non-zero. The runner runs `bun run build` before celld, so the deploy
 * row closes `failed` without ever reaching a fleet. */
const breakBuild = (dir: string): void => {
  const file = nodePath.join(dir, "package.json");

  // SAFETY: the sample's package.json is a JSON object with optional scripts;
  // the field is added below and the spec never reads it back.
  const pkg = JSON.parse(readFileSync(file, "utf-8")) as {
    scripts?: Record<string, string>;
  };

  pkg.scripts = { ...pkg.scripts, build: "exit 1" };
  writeFileSync(file, JSON.stringify(pkg, null, 2));
};

/** Owner rule (2026-11-10): two consecutive failed deploys of the same sha
 * pause the runner's automatic retries of it. The second failure comes from
 * the fallback tip sweep (the push itself only fires once), the app row
 * reports the pause, the Deployments tab says why, and a new push deploys. */
test("two failed deploys of one sha pause automatic retries", async ({
  page,
  request,
}) => {
  createdApps.push(SLUG);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Paused",
    slug: SLUG,
  });

  const broken = pushAppDir(
    apiKey,
    new URL("../test", import.meta.url),
    SLUG,
    breakBuild
  );

  const first = await waitForDeploy(request, appId, 8 * 60_000, broken);
  expect(first.status, first.log).toBe("failed");

  // The sweep retries the tip after its interval; the second failure spends
  // the budget. Poll the derived state (never a clock): `exhausted` can only
  // be observed after two rows closed.
  await expect
    .poll(
      async () => {
        const row = await runnerApi<AppRow>(request, `/v1/apps/${appId}`);

        return row.autoDeploy.state;
      },
      { timeout: 5 * 60_000 }
    )
    .toBe("exhausted");

  const paused = await runnerApi<AppRow>(request, `/v1/apps/${appId}`);
  expect(paused.autoDeploy.sha).toBe(broken);
  expect(paused.autoDeploy.failures).toBe(2);

  const rows = await runnerApi<DeployRow[]>(
    request,
    `/v1/apps/${appId}/deploys`
  );

  expect(
    rows.filter((row) => row.sha === broken).map((row) => row.status)
  ).toEqual(["failed", "failed"]);

  // The Deployments tab states the pause and names the sha, so the history
  // that stopped growing is never read as "still trying".
  await page.goto(`/apps/${appId}?t=deployments`);
  await expect(
    page.getByText(
      `Automatic deploys paused after 2 failed attempts of ${broken.slice(0, 12)}`
    )
  ).toBeVisible({ timeout: 30_000 });

  // A new sha is a new budget: the fixed push deploys normally.
  const fixed = pushAppDir(apiKey, new URL("../test", import.meta.url), SLUG);
  const live = await waitForDeploy(request, appId, 8 * 60_000, fixed);
  expect(live.status, live.log).toBe("success");
});
