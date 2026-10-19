/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { beforeEach, describe, expect, test } from "bun:test";

import { ensureDbPromise, setD1Binding } from "../../lib/db";
import { createTestD1 } from "../../testing/d1";
import {
  handleSourceArchive,
  handleSourceCommit,
  handleSourcePreview,
} from "./source";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "commit-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
  RUNNER_TOKEN: "runner-secret",
};

const COMMIT_URL = "http://localhost:9080/api/apps/app_1/source/commit";
const PREVIEW_URL = "http://localhost:9080/api/apps/app_1/source/preview";

/** An empty header value deletes the header, so a case can drop `Origin`. */
const call = async (
  init: { body?: string; headers?: Record<string, string> } = {},
  url: string = COMMIT_URL
): Promise<Response | undefined> => {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:9080",
  });
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (value === "") {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }
  const request = new Request(url, {
    body: init.body ?? `{"message":"m","files":[]}`,
    headers,
    method: "POST",
  });
  const handle = url === PREVIEW_URL ? handleSourcePreview : handleSourceCommit;
  return await handle(request, ENV as unknown as never, { appId: "app_1" });
};

const ARCHIVE_URL =
  "http://localhost:9080/api/apps/app_1/source/archive?ref=main";

/** A GET carries no `Origin` same-origin; the archive route's cross-site gate
 * is `Sec-Fetch-Site`, which a browser always sends. */
const archiveCall = async (
  headers: Record<string, string> = {}
): Promise<Response | undefined> => {
  const request = new Request(ARCHIVE_URL, {
    headers: { "sec-fetch-site": "same-origin", ...headers },
    method: "GET",
  });
  return await handleSourceArchive(request, ENV as unknown as never, {
    appId: "app_1",
  });
};

beforeEach(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

describe("POST /api/apps/:appId/source/commit", () => {
  test("requires a JSON content type before reading the body", async () => {
    const response = await call({ headers: { "content-type": "text/plain" } });
    expect(response?.status).toBe(415);
  });

  test("refuses a foreign origin", async () => {
    const response = await call({
      headers: { origin: "https://tenant.example" },
    });
    expect(response?.status).toBe(403);
  });

  test("refuses a missing origin", async () => {
    // A browser always sends `Origin` on POST, and only the control UI's own
    // fetch calls this route.
    const response = await call({ headers: { origin: "" } });
    expect(response?.status).toBe(403);
  });

  test("requires a session", async () => {
    const response = await call();
    expect(response?.status).toBe(401);
  });
});

describe("POST /api/apps/:appId/source/preview", () => {
  test("gates exactly like a commit: content type, then origin, then session", async () => {
    const wrongType = await call(
      { headers: { "content-type": "text/plain" } },
      PREVIEW_URL
    );
    expect(wrongType?.status).toBe(415);
    const foreign = await call(
      { headers: { origin: "https://tenant.example" } },
      PREVIEW_URL
    );
    expect(foreign?.status).toBe(403);
    const signedOut = await call({}, PREVIEW_URL);
    expect(signedOut?.status).toBe(401);
  });
});

describe("GET /api/apps/:appId/source/archive", () => {
  test("requires a session", async () => {
    const response = await archiveCall();
    expect(response?.status).toBe(401);
  });

  test("refuses a cross-site request", async () => {
    const response = await archiveCall({ "sec-fetch-site": "cross-site" });
    expect(response?.status).toBe(403);
  });
});
