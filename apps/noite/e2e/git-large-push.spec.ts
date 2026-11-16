import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  pushAppDir,
  waitForDeploy,
} from "./helpers";

/** Probes and chunked large pushes: a push whose pack exceeds git's
 * `http.postBuffer` (1 MiB) starts with a flush-only RPC probe (`0000`) and
 * then streams the real pack chunked. The probe must answer 200 without
 * changing any ref, and the chunked body — larger than the 2 MiB default the
 * route used to inherit — must land and deploy. */
const SLUG = "large-push";

test.afterAll(async ({ request }) => {
  await deleteApp(request, SLUG);
});

test("a push larger than git postBuffer lands and deploys", async ({
  page,
  request,
}) => {
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Large Push",
    slug: SLUG,
  });

  const sha = pushAppDir(
    apiKey,
    new URL("../test", import.meta.url),
    SLUG,
    (dir) => {
      // Incompressible, so the pack stays past postBuffer whatever the
      // transport negotiates.
      writeFileSync(`${dir}/large-blob.bin`, randomBytes(3 * 1024 * 1024));
    }
  );

  const deploy = await waitForDeploy(request, appId, undefined, sha);
  expect(deploy.status).toBe("success");
});
