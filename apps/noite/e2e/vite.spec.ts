import { expect, test } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  pushAppDir,
  waitForDeploy,
} from "./helpers";

const VITE_SLUG = "vite";

// A Vite app with @cloudflare/vite-plugin (apps/noite/test/vite), a pnpm
// project with no pin: the runner builds it with pnpm and deploys the build output through Wrangler's deploy redirect,
// not the source wrangler.jsonc. The Worker's `?raw` import only resolves in
// the built bundle, so serving it proves which one shipped.
test("vite build output is what deploys", async ({ page, request }) => {
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Vite",
    slug: VITE_SLUG,
  });

  pushAppDir(apiKey, new URL("../test/vite", import.meta.url), VITE_SLUG);
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status, deploy.log).toBe("success");
  // Unpinned, with a pnpm-lock.yaml: pnpm through jup (package_manager.rs).
  expect(deploy.log).toContain("▸ install: pnpm install (pnpm-lock.yaml)");
  expect(deploy.log).toContain("▸ build: pnpm run build");
  expect(deploy.log).toContain(
    "config: dist/wrangler.json (from dist/vite_sample/wrangler.json"
  );

  const base = `http://localhost:${await appListenPort(request, appId)}`;
  // A first deploy spawns the fleet; its port resets connections until
  // celld listens.
  await expect
    .poll(
      async () => {
        const res = await request.get(`${base}/api/greeting`).catch(() => null);
        return res?.ok() ? await res.json() : null;
      },
      { intervals: [1000], timeout: 60_000 }
    )
    .toEqual({ greeting: "hello from vite" });

  const home = await request.get(`${base}/`);
  expect(home.ok()).toBe(true);
  expect(await home.text()).toContain("Vite on Noite");

  // Cloudflare's SPA fallback answers navigations with index.html.
  const deep = await request.get(`${base}/some/client/route`, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
  });
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toContain("Vite on Noite");
});
