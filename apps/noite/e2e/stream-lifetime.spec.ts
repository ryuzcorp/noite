import { expect, test } from "@playwright/test";

import { deleteApp, findAppId, waitForCreatedApp } from "./helpers";

/** How long the stream is held. It has to outlive the control fleet's fetch
 * budget (the e2e lane sets `RUNNER_CONTROL_FETCH_TIMEOUT_S=5`) by several
 * times over, and pass the runner's 15 s SSE keepalive so a keepalive frame
 * is observed on the wire. */
const HOLD_MS = 22_000;

/** The shortest real hold: the budget has to be spent before we claim the
 * body outlived it. */
const MIN_HOLD_MS = 18_000;

interface HoldResult {
  ok: boolean;
  ms: number;
  chunks: number;
  keepalives: number;
  bytes: number;
  closed: boolean;
  error: string | null;
}

/** Every control-plane live feed is proxied through a Worker `fetch()` to the
 * runner, and `RUNNER_CONTROL_FETCH_TIMEOUT_S` bounds that fetch's head, never
 * a live response body: the state stream must stay open while keepalives
 * flow. A total-deadline regression truncates it at the budget instead of
 * leaving it open (the dogfood symptom was a cut at 120 s). */
test("control state stream outlives the control fetch budget", async ({
  page,
  request,
}) => {
  const slug = `sse-lifetime-${Date.now().toString(36)}`;
  const result = await (async () => {
    await page.goto("/apps/new");
    await page.locator("#create-name").fill("SSE Lifetime");
    await page.locator("#create-slug").fill(slug);
    await page.getByRole("button", { name: "Create app" }).click();
    await waitForCreatedApp(page);

    const appId = await findAppId(request, slug);
    expect(appId, `app ${slug} was created`).not.toBeNull();

    return await page.evaluate(
      async ({ id, holdMs }): Promise<HoldResult> => {
        const started = performance.now();
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), holdMs);
        let chunks = 0;
        let keepalives = 0;
        let bytes = 0;
        let closed = false;
        const out = (error: string | null): HoldResult => ({
          ok: error === null,
          ms: performance.now() - started,
          chunks,
          keepalives,
          bytes,
          closed,
          error,
        });

        try {
          const response = await fetch(`/api/apps/${id}/state/stream`, {
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
          });

          if (!(response.ok && response.body)) {
            return out(`status ${response.status}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          for (;;) {
            const { done, value } = await reader.read();

            if (done) {
              closed = true;
              break;
            }

            chunks += 1;
            bytes += value.length;

            for (const line of decoder
              .decode(value, { stream: true })
              .split("\n")) {
              // A bare `:` line is an SSE comment: the runner's keepalive.
              if (line.trim() === ":") {
                keepalives += 1;
              }
            }
          }
        } catch (error) {
          // Our own abort at the end of the hold is the expected exit; any
          // other failure (a truncated chunked body reports a TypeError) is
          // the regression under test.
          if (error instanceof DOMException && error.name === "AbortError") {
            return out(null);
          }

          return out(String(error));
        } finally {
          clearTimeout(abort);
        }

        return out(null);
      },
      { holdMs: HOLD_MS, id: appId ?? "" }
    );
  })();

  try {
    expect(result.error, JSON.stringify(result)).toBeNull();
    expect(result.closed, `stream closed before the hold: ${JSON.stringify(result)}`).toBe(false);
    expect(result.ms).toBeGreaterThan(MIN_HOLD_MS);
    expect(
      result.keepalives,
      `no keepalive frame arrived, so nothing proved the stream live: ${JSON.stringify(result)}`
    ).toBeGreaterThan(0);
  } finally {
    await deleteApp(request, slug);
  }
});
