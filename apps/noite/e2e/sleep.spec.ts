import { expect, test } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerCall,
  waitForDeploy,
} from "./helpers";

const SLEEP_SLUG = "e2e-sleep";

test.afterAll(async ({ request }) => {
  await deleteApp(request, SLEEP_SLUG);
});

// Scale to zero: forcing an app asleep parks its fleet, and the first
// request through the edge wakes it and is served — not the starting page.
// The sleep goes through the operator lever (no idle-threshold wall-clock),
// and the wake waits on the fleet's health gate, so the assertions below
// await real signals with generous timeouts instead of sleeping.
test(
  "sleep wakes on request through the edge",
  { tag: "@fast" },
  async ({ page, request }) => {
    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "E2E Sleep",
      slug: SLEEP_SLUG,
    });

    pushAppDir(apiKey, new URL("../test", import.meta.url), SLEEP_SLUG);
    const deploy = await waitForDeploy(request, appId);
    expect(deploy.status).toBe("success");

    const edgeBase = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

    const edgeHost = `${SLEEP_SLUG}.noite.localhost`;

    const readThroughEdge = async (): Promise<{
      status: number;
      body: string;
    }> => {
      const res = await request.get(`${edgeBase}/?read=1`, {
        headers: { host: edgeHost },
        timeout: 120_000,
      });

      return { body: await res.text(), status: res.status() };
    };

    // Sanity: the deployed app serves through the edge before sleep.
    const before = await readThroughEdge();
    expect(before.status).toBe(200);
    expect(before.body).toContain('"n"');

    // Park the fleet through the operator lever.
    const slept = await runnerCall(request, `/v1/apps/${appId}/sleep`, {
      method: "POST",
    });

    expect(slept.status).toBe(200);

    // First request after sleep wakes the fleet and is served with the
    // app's content. A dead wake path would answer the starting page
    // (503 + "This app is starting") instead.
    const woken = await readThroughEdge();
    expect(woken.status).toBe(200);
    expect(woken.body).toContain('"n"');
    expect(woken.body).not.toContain("This app is starting");

    // Awake now: the next request is fast, with no hold.
    const again = await readThroughEdge();
    expect(again.status).toBe(200);
  }
);
