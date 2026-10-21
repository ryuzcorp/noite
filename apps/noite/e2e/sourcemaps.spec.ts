import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  deleteApp,
  pushAppDir,
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

/** Runner JSON-RPC through the raw-port lane, unwrapping `result`. */
const rpc = async <T>(
  request: APIRequestContext,
  method: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- params differ per method; the runner parses per-method and rejects mismatches.
  params: Record<string, unknown>
): Promise<T> => {
  const { body, status } = await runnerCall(request, "/rpc", {
    body: { id: 1, jsonrpc: "2.0", method, params },
    method: "POST",
  });

  expect(status).toBe(200);

  // SAFETY: the runner answers JSON-RPC `{ result }` on success; anything else fails the expects below.
  const payload = body as {
    error?: { code: number; message: string };
    result?: T;
  };

  expect(payload.error).toBeUndefined();

  // SAFETY: error is undefined above, so this is a success envelope carrying `result`.
  return payload.result as T;
};

/** One open issue whose message contains `needle`, or null. */
const findIssue = async (
  request: APIRequestContext,
  appId: string,
  needle: string
): Promise<ErrorDetail | null> => {
  const listed = await rpc<ErrorList>(request, "errors.list", {
    id: appId,
    status: "open",
  });

  for (const issue of listed.issues) {
    if (issue.message.includes(needle)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one detail read per candidate; issues are few
      const detail = await rpc<ErrorDetail>(request, "errors.get", {
        fingerprint: issue.fingerprint,
        id: appId,
      });

      return detail;
    }
  }

  return null;
};

// Source maps: a Worker throw and a browser throw both symbolicate to their
// original files in the Errors tab, resolved from the deploy's stored maps.
test("worker and browser errors symbolicate to original sources", async ({
  page,
  request,
}) => {
  createdApps.push(SOURCEMAPS_SLUG);
  const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Sourcemaps",
    slug: SOURCEMAPS_SLUG,
  });

  const ingest = await rpc<IngestKey>(request, "errors.ingest_key", {
    id: appId,
    role: "admin",
  });

  const dsn = `http://${ingest.key}@${new URL(control).host}/${ingest.projectId}`;

  pushAppDir(apiKey, new URL("../test/vite", import.meta.url), SOURCEMAPS_SLUG);
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status, deploy.log).toBe("success");
  expect(deploy.log).toMatch(/sourcemaps: /u);

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
  // Telemetry flushes every ~30 s and the ingest pass runs after it.
  await expect
    .poll(() => findIssue(request, appId, "worker-boom"), {
      intervals: [5000],
      timeout: 300_000,
    })
    .not.toBeNull();

  const worker = await findIssue(request, appId, "worker-boom");

  if (worker === null) {
    throw new Error("worker-boom issue never appeared");
  }

  const workerFrames = worker.events.flatMap((event) => event.frames);

  const workerMapped = workerFrames.find((frame) => frame.mappedLocation);

  expect(workerMapped).toBeDefined();
  expect(workerMapped?.mappedLocation).toContain("src/index.ts");

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
