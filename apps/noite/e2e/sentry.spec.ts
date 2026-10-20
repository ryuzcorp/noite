import { readFileSync } from "node:fs";

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

const SENTRY_SLUG = "sentry";

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

interface ErrorEvent {
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

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../src/lib/sentry-fixtures/${name}`, import.meta.url),
    "utf-8"
  );

// One app, one deploy, many assertions: envelope drops, a real SDK browser
// error, refusals and a transaction envelope all run against the same tenant.
test("browser errors reach the Errors tab through the Sentry envelope route", async ({
  page,
  request,
}) => {
  createdApps.push(SENTRY_SLUG);
  const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Sentry",
    slug: SENTRY_SLUG,
  });

  const ingest = await rpc<IngestKey>(request, "errors.ingest_key", {
    id: appId,
    role: "admin",
  });

  expect(ingest.projectId).toBeGreaterThan(0);
  expect(ingest.key.length).toBeGreaterThan(0);

  // The SDK derives the store endpoint from the DSN: posts land on the
  // control origin at /api/<projectId>/envelope/?sentry_key=<key>.
  const envelopeUrl = `${control}/api/${ingest.projectId}/envelope/?sentry_key=${ingest.key}`;
  const dsn = `http://${ingest.key}@${new URL(control).host}/${ingest.projectId}`;
  const headers = { "content-type": "application/x-sentry-envelope" };

  pushAppDir(apiKey, new URL("../test/vite", import.meta.url), SENTRY_SLUG);
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status, deploy.log).toBe("success");

  const base = `http://localhost:${await appListenPort(request, appId)}`;
  // The sentry hook must not break the sample: greeting still answers, and a
  // first deploy's fleet needs this warm-up before the browser visits.
  await expect
    .poll(
      async () => {
        const res = await request.get(`${base}/api/greeting`).catch(() => null);

        return res?.ok() ? await res.json() : null;
      },
      { intervals: [1000], timeout: 60_000 }
    )
    .toEqual({ greeting: "hello from vite" });

  // --- drop-only first: a session envelope creates nothing ------------------
  const sessionBytes = fixture("session.envelope.txt");

  const dropped = await request.post(envelopeUrl, {
    data: sessionBytes,
    headers,
  });

  expect(dropped.status()).toBe(200);

  const empty = await rpc<ErrorList>(request, "errors.list", {
    id: appId,
    status: "open",
  });

  expect(empty.issues).toEqual([]);
  expect(empty.counts.open).toBe(0);

  // --- a real SDK browser error ---------------------------------------------
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`${base}/?dsn=${encodeURIComponent(dsn)}&boom=${token}`);

  await expect
    .poll(
      async () => {
        const open = await rpc<ErrorList>(request, "errors.list", {
          id: appId,
          status: "open",
        });

        return open.issues;
      },
      { intervals: [2000], timeout: 90_000 }
    )
    .toHaveLength(1);

  const listed = await rpc<ErrorList>(request, "errors.list", {
    id: appId,
    status: "open",
  });

  const [issue] = listed.issues;

  const detail = await rpc<ErrorDetail>(request, "errors.get", {
    fingerprint: issue?.fingerprint,
    id: appId,
  });

  expect(detail.issue.message).toContain(token);

  const [first] = detail.events;

  expect(first?.source).toBe("browser");
  expect(first?.url).toContain(base);
  expect(first?.release).toBe("vite-sample@e2e");

  // The Errors tab renders the issue (status filter `es` defaults to open).
  await page.goto(`/apps/${appId}?t=errors`);
  await expect(page.getByText(token).first()).toBeVisible();

  // --- refusals: cheap posts, no new issues ---------------------------------
  const wrongKey = await request.post(
    `${control}/api/${ingest.projectId}/envelope/?sentry_key=not-the-key`,
    { data: sessionBytes, headers }
  );

  expect(wrongKey.status()).toBe(403);

  const unknownProject = await request.post(
    `${control}/api/999999999/envelope/?sentry_key=${ingest.key}`,
    { data: sessionBytes, headers }
  );

  expect(unknownProject.status()).toBe(403);
  expect(await unknownProject.text()).toBe(await wrongKey.text());

  const preflight = await request.fetch(envelopeUrl, { method: "OPTIONS" });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()["access-control-allow-origin"]).toBe("*");

  const oversize = await request.post(envelopeUrl, {
    data: "x".repeat(250 * 1024),
    headers,
  });

  expect(oversize.status()).toBe(413);

  // --- transaction envelopes are accepted and ignored -----------------------
  const stored = await request.post(envelopeUrl, {
    data: fixture("spans.envelope.txt"),
    headers,
  });

  expect(stored.status()).toBe(200);

  const still = await rpc<ErrorList>(request, "errors.list", {
    id: appId,
    status: "open",
  });

  expect(still.issues).toHaveLength(1);
  expect(still.counts.open).toBe(1);
});
