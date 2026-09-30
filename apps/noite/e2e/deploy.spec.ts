import { expect, test } from "@playwright/test";

import {
  E2E_SLUG,
  appListenPort,
  createAppWithKey,
  pushSampleApp,
  readSampleApp,
  waitForDeploy,
} from "./helpers";

// Full loop: create app → mint API key → git push → deploy → serve.
// Runs under the registered session (storageState from auth.setup).
test("push to deploy serves traffic", async ({ page, request }) => {
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "E2E App",
    slug: E2E_SLUG,
  });

  pushSampleApp(apiKey);

  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status).toBe("success");

  const port = await appListenPort(request, appId);
  const body = await readSampleApp(request, port);
  expect(Number.isInteger(body.n)).toBe(true);
});
