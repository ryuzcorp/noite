import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerCall,
  waitForDeploy,
} from "./helpers";

const SLUG = "stop";

/** The deploy this spec creates, dropped afterwards: the account's app quota
 * (10) is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

interface DeployRow {
  id: string;
  sha: string | null;
  status: string;
  log: string;
}

/** The deploy row for `sha`, or undefined while the push has not landed. */
const deployFor = async (
  request: APIRequestContext,
  appId: string,
  sha: string
): Promise<DeployRow | undefined> => {
  const res = await runnerCall(request, `/v1/apps/${appId}/deploys`);

  if (res.status !== 200) {
    return undefined;
  }

  // SAFETY: the deploys endpoint answers a JSON array of deploy rows (the
  // same shape the UI decodes on its stream).
  return (res.body as DeployRow[]).find((row) => row.sha === sha);
};

// The Deployments tab's Stop closes an in-flight row as `cancelled` (read as
// "Stopped") without touching the serving release, and the app's next push
// still deploys: the claim the stopped run held is released, so nothing
// wedges.
test(
  "stopping a deploy closes its row and the app keeps deploying",
  { tag: "@fast" },
  async ({ page, request }) => {
    createdApps.push(SLUG);

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Stop",
      slug: SLUG,
    });

    const sha = pushAppDir(apiKey, new URL("../test", import.meta.url), SLUG);
    const first = await waitForDeploy(request, appId, 8 * 60_000, sha);
    expect(first.status, first.log).toBe("success");

    const second = pushAppDir(
      apiKey,
      new URL("../test", import.meta.url),
      SLUG
    );

    expect(second).not.toBe(sha);

    // The row appears when the runner takes the push; a bounded wait keeps a
    // slow reconcile tick from looking like a 404.
    let row: DeployRow | undefined;
    await expect
      .poll(
        async () => {
          row = await deployFor(request, appId, second);

          return row?.id ?? "";
        },
        { timeout: 60_000 }
      )
      .not.toBe("");
    expect(row).toBeDefined();

    // Stop while the build is live. A very fast box may finish first; either
    // answer is honest, and the row must then already be closed.
    const cancel = await runnerCall(
      request,
      `/v1/apps/${appId}/deploys/${row?.id ?? ""}/cancel`,
      { method: "POST" }
    );

    if (cancel.status === 200) {
      const stopped = await waitForDeploy(request, appId, 8 * 60_000, second);

      expect(stopped.status, stopped.log).toBe("cancelled");
      expect(stopped.log).toContain("cancelled by the operator");
    } else {
      expect(cancel.status).toBe(409);
    }

    // Stopping a finished deploy is a conflict, never a second failure.
    const again = await runnerCall(
      request,
      `/v1/apps/${appId}/deploys/${row?.id ?? ""}/cancel`,
      { method: "POST" }
    );

    expect(again.status).toBe(409);

    // The stopped run released the app: the next push deploys normally.
    const third = pushAppDir(apiKey, new URL("../test", import.meta.url), SLUG);
    const live = await waitForDeploy(request, appId, 8 * 60_000, third);
    expect(live.status, live.log).toBe("success");
  }
);
