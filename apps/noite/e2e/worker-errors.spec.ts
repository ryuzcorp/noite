import { readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerCall,
  waitForDeploy,
} from "./helpers";

const WORKER_ERRORS_SLUG = "worker-errors";

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

interface ErrorIssue {
  fingerprint: string;
  handler: string;
  kind: string;
  message: string;
  source: string;
}

interface ErrorList {
  counts: { ignored: number; open: number; resolved: number };
  issues: ErrorIssue[];
}

interface ErrorFrame {
  function: string;
  inApp: boolean;
  location: string;
}

interface ErrorEvent {
  frames: ErrorFrame[];
  handler: string;
  httpStatus: number;
  kind: string;
  message: string;
  method: string;
  path: string;
  source: string;
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

/** Push the vite sample with a throwing route baked in: the token lands in
 * the thrown message at push time, so the run's issue is unambiguous even
 * on a reused lane.
 *
 * The hook handler is `async`: celld's bucket OTel sink does not export a
 * span when a non-async `fetch` throws (verified on 0.6.0–0.6.2 with a
 * standalone node; an async handler's `rejected: …` span records fine), so
 * a sync hook could never reach the ingest no matter what the runner does.
 * The sync-throw gap is reported upstream; this spec pins the runner side
 * of the path with the shape celld exports. */
const pushBoomRevision = (apiKey: string, token: string): string =>
  pushAppDir(
    apiKey,
    new URL("../test/vite", import.meta.url),
    WORKER_ERRORS_SLUG,
    (dir) => {
      const file = nodePath.join(dir, "src", "index.ts");
      const before = readFileSync(file, "utf-8");
      const signature = "fetch(request: Request): Response {";
      const anchor = 'return new Response("not found", { status: 404 });';

      if (!before.includes(signature) || !before.includes(anchor)) {
        throw new Error("the vite sample worker moved; update the boom hook");
      }

      const hook = `if (pathname === "/api/phase1-boom") {
      // E2E hook (worker-errors.spec.ts): throws inside the Worker so the
      // Errors tab records an uncaught Worker issue carrying the token.
      throw new Error("phase1-boom-${token}");
    }

    `;

      writeFileSync(
        file,
        before
          .replace(
            signature,
            "async fetch(request: Request): Promise<Response> {"
          )
          .replace(anchor, hook + anchor)
      );
    }
  );

// Phase 1: a Worker throw travels celld OTel flush → bucket parquet →
// runner ingest → Errors tab as an `uncaught` issue with its request.
test("a worker throw becomes an errors-tab issue", async ({
  page,
  request,
}) => {
  createdApps.push(WORKER_ERRORS_SLUG);

  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Worker Errors",
    slug: WORKER_ERRORS_SLUG,
  });

  pushBoomRevision(apiKey, token);
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status, deploy.log).toBe("success");

  // Through the lane Caddy, not the raw fleet port: the tenant site sets a
  // sampled `traceparent` and logs the same `traceID` in the access log, so
  // the ingest joins the exception to its method, path and status
  // (host/errors.rs `RequestIndex`) — the join this spec's assertions pin.
  const base = `http://${WORKER_ERRORS_SLUG}.noite.localhost:8090`;
  // A first deploy spawns the fleet; the site answers 502/503 until celld
  // listens.
  await expect
    .poll(
      async () => {
        const res = await request.get(`${base}/api/greeting`).catch(() => null);

        return res?.ok() ? await res.json() : null;
      },
      { intervals: [1000], timeout: 60_000 }
    )
    .toEqual({ greeting: "hello from vite" });

  // The 500 proves the Worker ran the new bundle and threw there, not at
  // the edge: only a Worker throw carries a span `error` for the ingest.
  const boom = await request.get(`${base}/api/phase1-boom`);
  expect(boom.status()).toBe(500);

  // End-to-end latency bound, derived from the lane's telemetry config:
  // celld flushes OTel to the bucket every RUNNER_OTEL_FLUSH_MS (30 s by
  // default), the runner ingests at most once per flush interval, and the
  // ingest window stops agg_lag (flush + 10 s = 40 s) behind now — so a
  // throw surfaces after ~100 s in the steady state. 300 s is 3x headroom
  // for a cold fleet and S3 listing, not a fix for slowness: a timeout here
  // is the failure this spec pins.
  await expect
    .poll(() => findIssue(request, appId, token), {
      intervals: [5000],
      timeout: 300_000,
    })
    .not.toBeNull();

  const detail = await findIssue(request, appId, token);

  if (detail === null) {
    throw new Error("worker throw issue never appeared");
  }

  expect(detail.issue.message).toContain(token);
  expect(detail.issue.kind).toBe("Error");
  expect(detail.issue.source).toBe("uncaught");
  expect(detail.issue.handler).toBe("fetch");

  const [first] = detail.events;

  expect(first?.source).toBe("uncaught");
  expect(first?.handler).toBe("fetch");
  expect(first?.kind).toBe("Error");
  expect(first?.message).toContain(token);
  expect(first?.method).toBe("GET");
  expect(first?.path).toBe("/api/phase1-boom");
  expect(first?.httpStatus).toBe(500);
  expect(first?.frames.length).toBeGreaterThan(0);
  expect(first?.frames.some((frame) => frame.inApp)).toBe(true);

  // The Errors tab renders the issue (status filter `es` defaults to open).
  await page.goto(`/apps/${appId}?t=errors`);
  await expect(page.getByText(token).first()).toBeVisible();
});
