/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { describe, expect, test } from "bun:test";

import {
  CONTROL_HOST_DENIED_ASSETS,
  POD_HOST_HTML_PATH,
  PREVIEW_ASSET_PREFIX,
} from "../lib/preview-host";
import { testRouteContext } from "../testing/context";
import podHost from "./02-pod-host";

/** A Preview host (`app-0.preview.<slug>.<base>`). */
const PREVIEW_HOST = "app-0.preview.demo.noite.example";

interface TestEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

const seen: string[] = [];
const ENV: TestEnv = {
  ASSETS: {
    fetch: (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return Promise.resolve(new Response("asset", { status: 200 }));
    },
  },
};

const gate = async (
  host: string,
  path: string,
  method = "GET",
  env: TestEnv = ENV
): Promise<{ nextCalls: number; response: Response | undefined }> => {
  let nextCalls = 0;
  const raw = await podHost(
    testRouteContext(
      new Request(`http://${host}${path}`, { headers: { host }, method }),
      env as unknown as never
    ),
    () => {
      nextCalls += 1;
      return Promise.resolve();
    }
  );
  return { nextCalls, response: raw ?? undefined };
};

describe("pod-host middleware", () => {
  test("answers every pod path on the Preview host", async () => {
    seen.length = 0;
    const paths = [
      ...CONTROL_HOST_DENIED_ASSETS,
      `${PREVIEW_ASSET_PREFIX}bundle-CKoOeS2C.js`,
    ];
    for (const path of paths) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: each path is asserted before the next
      const { nextCalls, response } = await gate(PREVIEW_HOST, path);
      expect(`${path} -> ${response?.status}/${nextCalls}`).toBe(
        `${path} -> 200/0`
      );
    }
    // Every path but the pod host document: that one is the app's own
    // response, so the static assets are never asked for it.
    expect(seen).toEqual(paths.filter((path) => path !== POD_HOST_HTML_PATH));
  });

  test("404s every denied pod path on the control hosts", async () => {
    for (const host of ["noite.example", "localhost:9080"]) {
      for (const path of CONTROL_HOST_DENIED_ASSETS) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: each host/path pair is asserted before the next
        const { nextCalls, response } = await gate(host, path);
        expect(`${host}${path} -> ${response?.status}/${nextCalls}`).toBe(
          `${host}${path} -> 404/0`
        );
      }
    }
  });

  test("leaves the control origin's own assets to the platform", async () => {
    const { nextCalls, response } = await gate(
      "localhost:9080",
      "/assets/index-CKoOeS2C.js"
    );
    expect(response).toBeUndefined();
    expect(nextCalls).toBe(1);
  });

  test("only decides GET and HEAD", async () => {
    const { nextCalls, response } = await gate(
      PREVIEW_HOST,
      POD_HOST_HTML_PATH,
      "POST"
    );
    expect(response).toBeUndefined();
    expect(nextCalls).toBe(1);
  });
});
