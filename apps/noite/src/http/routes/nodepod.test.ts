/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { describe, expect, test } from "bun:test";

import {
  CONTROL_HOST_DENIED_ASSETS,
  POD_HOST_HTML_PATH,
  POD_WORKER_PATH,
  PREVIEW_ASSET_PREFIX,
} from "../../lib/preview-host";
import { handlePreviewHostAsset } from "./nodepod";

/** A Preview host as `previewHost` builds it (`app-0.preview.<slug>.<base>`). */
const PREVIEW_HOST = "app-0.preview.demo.noite.example";

/** The hosts the control UI answers on — none of them a Preview host. */
const CONTROL_HOSTS = ["noite.example", "localhost:9080"];

/** The slice of the Worker env these tests stand in for. */
interface TestEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

/** Assets that answer every request and record what it was asked for. */
const assetsThatServe = (seen: string[]) => ({
  ASSETS: {
    fetch: (request: Request) => {
      const url = new URL(request.url);
      seen.push(url.pathname);

      return Promise.resolve(
        new Response(`asset:${url.pathname}`, { status: 200 })
      );
    },
  },
});

const call = (host: string, path: string, env: TestEnv) =>
  // SAFETY: the handler reads only `ASSETS` from the Worker env.
  handlePreviewHostAsset(
    new Request(`http://${host}${path}`, { headers: { host } }),
    env as unknown as never
  );

describe("preview host assets", () => {
  test("serves the pod host document from the app", async () => {
    const seen: string[] = [];

    const response = await call(
      PREVIEW_HOST,
      POD_HOST_HTML_PATH,
      assetsThatServe(seen)
    );

    // The document is the app's own response, not an asset: the control UI
    // embeds it cross-origin, so it carries its own Resource-Policy and
    // isolation headers instead of the deployment's `/*` static-asset rules.
    expect(seen).toEqual([]);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin"
    );
    expect(response?.headers.get("cross-origin-embedder-policy")).toBe(
      "require-corp"
    );
    // The document points at the built frame bundle, the fixed path the client
    // build gives `src/pod-host/main.ts`.
    expect(await response?.text()).toContain(
      '<script src="/noite-pod-host.js" type="module"></script>'
    );
  });

  test("serves the frame bundle, Nodepod's assets and the bundle's chunks", async () => {
    for (const path of [
      "/noite-pod-host.js",
      "/__sw__.js",
      POD_WORKER_PATH,
      `${PREVIEW_ASSET_PREFIX}index-CKoOeS2C.js`,
    ]) {
      const seen: string[] = [];
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: each path is asserted before the next
      const response = await call(PREVIEW_HOST, path, assetsThatServe(seen));
      // The frame loads its own chunks from this origin (`PREVIEW_ASSET_PREFIX`),
      // so the whole asset directory is the preview host's to serve.
      expect(`${path} -> ${seen.join(",")}`).toBe(`${path} -> ${path}`);
      expect(response?.status).toBe(200);
    }
  });

  test("404s every denied pod path on the control hosts", async () => {
    for (const host of CONTROL_HOSTS) {
      for (const path of CONTROL_HOST_DENIED_ASSETS) {
        const seen: string[] = [];
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: each case is asserted before the next
        const response = await call(host, path, assetsThatServe(seen));
        // The invariant: nothing that could create a worker or a *registerable*
        // service worker is served from the control origin.
        expect(`${host}${path} -> ${response?.status}`).toBe(
          `${host}${path} -> 404`
        );
        expect(seen).toEqual([]);
      }
    }
  });

  test("leaves the control origin's own assets to the platform", async () => {
    // A chunk of the frame bundle is a chunk of the control UI's bundle too:
    // on the control origin it is served exactly as it was before this route
    // existed, or the whole UI would 404 its own scripts.
    for (const host of CONTROL_HOSTS) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: each host is asserted before the next
      const response = await call(
        host,
        `${PREVIEW_ASSET_PREFIX}index-CKoOeS2C.js`,
        assetsThatServe([])
      );

      expect(response).toBeUndefined();
    }
  });

  test("404s a pod asset when the deployment carries no Assets binding", async () => {
    const response = await call(PREVIEW_HOST, POD_WORKER_PATH, {});
    expect(response?.status).toBe(404);
  });
});
