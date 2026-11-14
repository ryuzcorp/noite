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

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../src/lib/sentry-fixtures/${name}`, import.meta.url),
    "utf-8"
  );

/** `runnerCall` widens its body to a union; each caller already knows the
 * shape its endpoint answers, so the cast is local to the read. */
const asJson = <T>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- runnerCall parses the body at the HTTP boundary; only its static type is unknown here.
  body: unknown
): T =>
  // SAFETY: the caller names the exact response type of the endpoint it hit.
  body as T;

/** One status's issue list for `appId` on the raw-port lane. */
const listErrors = async (
  request: APIRequestContext,
  appId: string,
  status: string
): Promise<ErrorList> => {
  const query = new URLSearchParams({ status });

  const { body, status: code } = await runnerCall(
    request,
    `/v1/apps/${encodeURIComponent(appId)}/errors?${query.toString()}`
  );

  expect(code).toBe(200);

  // SAFETY: the errors list endpoint answers `ErrorList`; the callers read
  // `issues` and `counts` only.
  return asJson<ErrorList>(body);
};

// One app, one deploy, many assertions: envelope drops, a real SDK browser
// error, refusals and a transaction envelope all run against the same tenant.
test(
  "browser errors reach the Errors tab through the Sentry envelope route",
  { tag: "@fast" },
  async ({ page, request }) => {
    createdApps.push(SENTRY_SLUG);
    const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Sentry",
      slug: SENTRY_SLUG,
    });

    const ingestQuery = new URLSearchParams({ role: "admin" });

    const ingestRes = await runnerCall(
      request,
      `/v1/apps/${encodeURIComponent(appId)}/errors/ingest-key?${ingestQuery.toString()}`
    );

    expect(ingestRes.status).toBe(200);

    // SAFETY: the ingest-key endpoint answers `IngestKey`; the assertions
    // below read `key` and `projectId` only.
    const ingest = asJson<IngestKey>(ingestRes.body);

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
          const res = await request
            .get(`${base}/api/greeting`)
            .catch(() => null);

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

    const empty = await listErrors(request, appId, "open");

    expect(empty.issues).toEqual([]);
    expect(empty.counts.open).toBe(0);

    // --- a real SDK browser error ---------------------------------------------
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await page.goto(`${base}/?dsn=${encodeURIComponent(dsn)}&boom=${token}`);

    await expect
      .poll(
        async () => {
          const open = await listErrors(request, appId, "open");

          return open.issues;
        },
        { intervals: [2000], timeout: 90_000 }
      )
      .toHaveLength(1);

    const listed = await listErrors(request, appId, "open");

    const [issue] = listed.issues;

    const detailRes = await runnerCall(
      request,
      `/v1/apps/${encodeURIComponent(appId)}/errors/${encodeURIComponent(String(issue?.fingerprint))}`
    );

    expect(detailRes.status).toBe(200);

    // SAFETY: the error detail endpoint answers `ErrorDetail`; the assertions
    // below read the issue message and the occurrence fields only.
    const detail = asJson<ErrorDetail>(detailRes.body);

    expect(detail.issue.message).toContain(token);

    const [first] = detail.events;

    expect(first?.source).toBe("browser");
    expect(first?.url).toContain(base);
    expect(first?.release).toBe("vite-sample@e2e");

    // The Errors tab renders the issue (status filter `es` defaults to open).
    await page.goto(`/apps/${appId}?t=errors`);
    await expect(page.getByText(token).first()).toBeVisible();

    // --- refusals: event envelopes with a bad identity are refused alike -----
    // (Drop-only envelopes skip the runner entirely, so refusal probes use an
    // event envelope; a wrong key with a session still answers 200.)
    const eventBytes = fixture("exception.envelope.txt");

    const wrongKey = await request.post(
      `${control}/api/${ingest.projectId}/envelope/?sentry_key=not-the-key`,
      { data: eventBytes, headers }
    );

    expect(wrongKey.status()).toBe(403);

    const unknownProject = await request.post(
      `${control}/api/999999999/envelope/?sentry_key=${ingest.key}`,
      { data: eventBytes, headers }
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

    const still = await listErrors(request, appId, "open");

    expect(still.issues).toHaveLength(1);
    expect(still.counts.open).toBe(1);
  }
);
