import { readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  deleteApp,
  pushAppDir,
  readSampleApp,
  runnerCall,
  waitForDeploy,
} from "./helpers";

const SLUG = "rollback";

// What `/files/test.txt` serves. The sample source spells the trailing
// newline as a `\n` escape, so the source is matched on the text before it.
const V1_MARKER = "hello from noite test app\n";
const V2_MARKER = "hello from rollback probe v2\n";
const sourceText = (marker: string): string => marker.trimEnd();

/** The app this spec creates, dropped afterwards: the account's app quota
 * (10) is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

/** Push the sample app with its R2 probe text replaced, so the live revision
 * is observable: `/upload-test-txt` writes the text, `/files/test.txt` reads
 * it back. */
const pushMarkerRevision = (apiKey: string, marker: string): string =>
  pushAppDir(apiKey, new URL("../test", import.meta.url), SLUG, (dir) => {
    const file = nodePath.join(dir, "index.ts");
    const before = readFileSync(file, "utf-8");

    if (!before.includes(sourceText(V1_MARKER))) {
      throw new Error("the R2 probe text moved; update the marker");
    }

    const after = before.replace(sourceText(V1_MARKER), sourceText(marker));
    writeFileSync(file, after);
  });

/** What the deployed revision currently serves for the probe text. */
const readMarker = async (
  request: APIRequestContext,
  port: number
): Promise<string> => {
  const base = `http://localhost:${port}`;
  const stored = await request.get(`${base}/upload-test-txt`);

  if (!stored.ok()) {
    throw new Error(`probe write ${stored.status()} ${await stored.text()}`);
  }

  const res = await request.get(`${base}/files/test.txt`);

  if (!res.ok()) {
    throw new Error(`probe read ${res.status()} ${await res.text()}`);
  }

  return res.text();
};

// Rollback re-runs the pipeline at an earlier successful deploy: deploy twice
// with observable revisions, roll back to the first sha, and the first
// revision serves again.
test(
  "rollback restores the earlier deploy",
  { tag: "@fast" },
  async ({ page, request }) => {
    createdApps.push(SLUG);

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Rollback",
      slug: SLUG,
    });

    const sha1 = pushMarkerRevision(apiKey, V1_MARKER);
    const first = await waitForDeploy(request, appId, 8 * 60_000, sha1);
    expect(first.status, first.log).toBe("success");

    const port = await appListenPort(request, appId);
    expect(await readMarker(request, port)).toBe(V1_MARKER);

    const sha2 = pushMarkerRevision(apiKey, V2_MARKER);
    expect(sha2).not.toBe(sha1);
    const second = await waitForDeploy(request, appId, 8 * 60_000, sha2);
    expect(second.status, second.log).toBe("success");
    expect(await readMarker(request, port)).toBe(V2_MARKER);

    const rolled = await runnerCall(request, `/v1/apps/${appId}/rollback`, {
      body: { sha: sha1 },
      method: "POST",
    });

    expect(rolled.status).toBe(200);
    expect(JSON.stringify(rolled.body)).toContain(sha1);

    const live = await waitForDeploy(request, appId, 8 * 60_000, sha1);
    expect(live.status, live.log).toBe("success");
    expect(live.sha).toBe(sha1);

    // The earlier revision serves traffic again, not just a matching row.
    expect(await readMarker(request, port)).toBe(V1_MARKER);
    const sample = await readSampleApp(request, port);
    expect(Number.isInteger(sample.n)).toBe(true);

    // The header's Deploy menu offers the rollback the history holds: the
    // previous successful production release (sha2) is one click from any tab,
    // not only the per-row button on the Deployments tab.
    await page.goto(`/apps/${appId}`);
    await page.getByRole("button", { exact: true, name: "Deploy" }).focus();
    await expect(
      page.getByRole("button", {
        name: `Roll back to ${sha2.slice(0, 12)}`,
      })
    ).toBeVisible();

    // Visible, not invisible: a rollback issued while another deploy holds
    // the app exists in the history as its own row the moment the API
    // answers (it then waits its turn or runs). The row's queued state is
    // pinned by the runner's queue tests; this asserts it is listed at once
    // rather than appearing only when its build starts.
    const inFlight = pushMarkerRevision(apiKey, V1_MARKER);
    expect(inFlight).not.toBe(sha1);

    // Hold the claim before asking: the rollback must contend with a live run.
    await expect
      .poll(
        async () => {
          const rows = await runnerCall(request, `/v1/apps/${appId}/deploys`);

          // SAFETY: the deploys endpoint answers a JSON array of rows.
          const row = (
            rows.body as { sha: string | null; status: string }[]
          ).find((r) => r.sha === inFlight);

          return row?.status ?? "";
        },
        { timeout: 60_000 }
      )
      .toMatch(/^(?<phase>building|deploying)$/u);

    const queued = await runnerCall(request, `/v1/apps/${appId}/rollback`, {
      body: { sha: sha1 },
      method: "POST",
    });

    expect(queued.status).toBe(200);

    // SAFETY: the rollback endpoint answers `{ deployId }` (its own contract,
    // asserted by the runner's transport tests).
    const rollbackId = (queued.body as { deployId?: string }).deployId ?? "";
    const listed = await runnerCall(request, `/v1/apps/${appId}/deploys`);

    // SAFETY: the deploys endpoint answers a JSON array of rows.
    const row = (listed.body as { id: string; sha: string | null }[]).find(
      (r) => r.id === rollbackId
    );

    expect(row?.sha).toBe(sha1);

    // …and it runs to success on its own row.
    const rolledAgain = await waitForDeploy(request, appId, 8 * 60_000, sha1);
    expect(rolledAgain.status, rolledAgain.log).toBe("success");
  }
);
