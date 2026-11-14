import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerApi,
  runnerCall,
  waitForDeploy,
} from "./helpers";

const SOURCEMAPS_SLUG = "sourcemaps";

/** The app this spec creates, dropped afterwards: the account's app quota
 * is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

interface IngestKey {
  key: string;
  projectId: number;
}

interface ErrorIssue {
  fingerprint: string;
  message: string;
}

interface ErrorList {
  counts: { ignored: number; open: number; resolved: number };
  issues: ErrorIssue[];
}

interface ErrorFrame {
  function: string;
  inApp: boolean;
  location: string;
  mappedFunction?: string | null;
  mappedLocation?: string | null;
}

interface ErrorEvent {
  frames: ErrorFrame[];
  release: string;
  source: string;
  url: string;
}

interface ErrorDetail {
  events: ErrorEvent[];
  issue: ErrorIssue;
}

/** `runnerCall` widens its body to a union; each caller already knows the
 * shape its endpoint answers, so the cast is local to the read. */
const asJson = <T>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- runnerCall parses the body at the HTTP boundary; only its static type is unknown here.
  body: unknown
): T =>
  // SAFETY: the caller names the exact response type of the endpoint it hit.
  body as T;

/** One open issue whose message contains `needle`, or null. */
const findIssue = async (
  request: APIRequestContext,
  appId: string,
  needle: string
): Promise<ErrorDetail | null> => {
  const listQuery = new URLSearchParams({ status: "open" });

  const listedRes = await runnerCall(
    request,
    `/v1/apps/${encodeURIComponent(appId)}/errors?${listQuery.toString()}`
  );

  expect(listedRes.status).toBe(200);

  // SAFETY: the errors list endpoint answers `ErrorList`; the loop below
  // reads `issues` only.
  const listed = asJson<ErrorList>(listedRes.body);

  for (const issue of listed.issues) {
    if (issue.message.includes(needle)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one detail read per candidate; issues are few
      const detailRes = await runnerCall(
        request,
        `/v1/apps/${encodeURIComponent(appId)}/errors/${encodeURIComponent(issue.fingerprint)}`
      );

      expect(detailRes.status).toBe(200);

      // SAFETY: the error detail endpoint answers `ErrorDetail`; the caller
      // reads its frames and issue only.
      const detail = asJson<ErrorDetail>(detailRes.body);

      return detail;
    }
  }

  return null;
};

// Source maps: a browser throw symbolicates to its original file in the
// Errors tab, resolved from the deploy's stored maps. The Worker-map path is
// unit-tested only (worker error telemetry is a separate investigation).
test("browser errors symbolicate to original sources", async ({
  page,
  request,
}) => {
  createdApps.push(SOURCEMAPS_SLUG);
  const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Sourcemaps",
    slug: SOURCEMAPS_SLUG,
  });

  const ingestQuery = new URLSearchParams({ role: "admin" });

  const ingestRes = await runnerCall(
    request,
    `/v1/apps/${encodeURIComponent(appId)}/errors/ingest-key?${ingestQuery.toString()}`
  );

  expect(ingestRes.status).toBe(200);

  // SAFETY: the ingest-key endpoint answers `IngestKey`; the DSN below reads
  // `key` and `projectId` only.
  const ingest = asJson<IngestKey>(ingestRes.body);

  const dsn = `http://${ingest.key}@${new URL(control).host}/${ingest.projectId}`;

  pushAppDir(apiKey, new URL("../test/vite", import.meta.url), SOURCEMAPS_SLUG);
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status, deploy.log).toBe("success");

  // The deploy row's own log proves the maps step ran for this sha.
  const deployLog = await runnerApi<{ log: string }>(
    request,
    `/v1/apps/${appId}/deploys/${deploy.id}/log`
  );

  expect(deployLog.log).toMatch(/sourcemaps: /u);

  const base = `http://localhost:${await appListenPort(request, appId)}`;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${base}/api/greeting`).catch(() => null);

        return res?.ok() ? await res.json() : null;
      },
      { intervals: [1000], timeout: 60_000 }
    )
    .toEqual({ greeting: "hello from vite" });

  // --- a browser throw symbolicates to the original client source -----------
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`${base}/?dsn=${encodeURIComponent(dsn)}&boom=${token}`);

  await expect
    .poll(() => findIssue(request, appId, `e2e-boom-${token}`), {
      intervals: [2000],
      timeout: 90_000,
    })
    .not.toBeNull();

  const browser = await findIssue(request, appId, `e2e-boom-${token}`);

  if (browser === null) {
    throw new Error("browser boom issue never appeared");
  }

  const browserFrames = browser.events.flatMap((event) => event.frames);
  const browserMapped = browserFrames.find((frame) => frame.mappedLocation);

  expect(browserMapped).toBeDefined();
  expect(browserMapped?.mappedLocation).toContain("src/client.ts");

  // --- the Errors tab renders the original frames ---------------------------
  const { fingerprint } = browser.issue;
  await page.goto(`/apps/${appId}?t=errors&e=${fingerprint}`);
  await expect(page.getByText("src/client.ts").first()).toBeVisible();
});
