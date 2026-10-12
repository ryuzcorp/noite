// The planner's own note strings, out of the module that has no browser
// dependency (`preview/index` reaches for the pod's APIs).
import { PREVIEW_NOTES } from "$lib/source/preview/plan";
import type { FrameLocator } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// Code mode's Preview panel runs the app itself: a plain Worker through a
// srvx server, or a Vite app built without the Cloudflare plugin (which cannot
// run in a browser). Both are served by the pod's own service worker on the
// app's preview host, never on this page's own origin.

const WORKER_SLUG = "preview-worker";
const VITE_SLUG = "preview-vite";

/** Every app this spec creates, dropped after the file: the account's app
 * quota (10) is shared by the whole lane, and a leftover slug fails the next
 * run's create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

/** The sample app's Counter through the frame: every `fetch` runs in the
 * frame's origin, against the preview host. */
const readCounter = (frame: FrameLocator): Promise<number> =>
  frame.locator("body").evaluate(async () => {
    const response = await fetch("/");
    // SAFETY: the sample app's root route answers `{ n, url, visits }`.
    const body = (await response.json()) as { n: number };
    return body.n;
  });
test("Preview runs a Worker with local bindings", async ({ page, request }) => {
  createdApps.push(WORKER_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Preview Worker",
    slug: WORKER_SLUG,
  });
  pushAppDir(apiKey, new URL("../test", import.meta.url), WORKER_SLUG);

  await page.goto(`/apps/${appId}/source?panel=preview`);
  const panel = page.getByRole("complementary", { name: "Preview" });
  await expect(panel).toBeVisible();
  // The plan says the bindings run locally, before anything starts: its notes
  // sit in the info icon's tooltip beside the panel's title.
  const info = panel.locator(".tooltip");
  await expect
    .poll(() => info.evaluate((element) => element.dataset.tip), {
      timeout: 240_000,
    })
    .toContain(PREVIEW_NOTES.localBindings);
  const frame = page.frameLocator('iframe[title="App preview"]');
  await expect(frame.locator("body")).toContainText('"n":', {
    timeout: 240_000,
  });

  // The sample app's routes: `/` answers the Counter's count,
  // `/upload-test-txt` stores an object, `/files` lists it.
  const first = await readCounter(frame);
  expect(first).toBeGreaterThanOrEqual(1);

  await frame.locator("body").evaluate(async () => {
    const response = await fetch("/upload-test-txt");
    if (!response.ok) {
      throw new Error(`upload failed: ${response.status}`);
    }
  });
  const listed = await frame.locator("body").evaluate(async () => {
    const response = await fetch("/files");
    // SAFETY: the sample app's `/files` answers `{ objects: [{ key, … }] }`.
    return (await response.json()) as { objects: { key: string }[] };
  });
  expect(listed.objects.map((object) => object.key)).toContain("test.txt");

  // `/` also writes the D1 visit row the panel has data to show.
  const root = await frame.locator("body").evaluate(async () => {
    const response = await fetch("/");
    // SAFETY: the sample app's root route answers `{ n, url, visits }`.
    return (await response.json()) as {
      n: number;
      visits: { id: number }[];
    };
  });
  expect(root.visits.length).toBeGreaterThan(0);

  // Every counting request advances the same object: the count grows.
  const second = await readCounter(frame);
  expect(second).toBeGreaterThan(first);

  // A page reload reboots the pod from its saved copy: the count carries on
  // from the persisted state instead of starting over.
  await page.reload();
  const reloaded = page.getByRole("complementary", { name: "Preview" });
  await expect(reloaded).toBeVisible();
  const again = page.frameLocator('iframe[title="App preview"]');
  await expect(again.locator("body")).toContainText('"n":', {
    timeout: 240_000,
  });
  const third = await readCounter(again);
  expect(third).toBeGreaterThan(second);

  // Switching tabs keeps the running preview: the panel keeps every tab it
  // has shown mounted, so the frame is never unmounted, the app is never
  // loaded again and its server is never restarted. The frame's own document
  // marks itself — a remounted or reloaded iframe has a new document, and the
  // mark went with the old one — and the address bar holds a path that was
  // never submitted, which only the panel's own state can bring back.
  await again.locator("body").evaluate(() => {
    document.documentElement.dataset.previewKept = "1";
  });
  const address = reloaded.getByLabel("Preview address");
  await address.fill("/kept-across-tabs");
  // `/^Changes/u`, not `exact`: the toggle carries the changed-file badge
  // ("Changes 1") once the preview has written its own files.
  await page.getByRole("button", { name: /^Changes/u }).click();
  await expect(
    page.getByRole("complementary", { name: "Changes" })
  ).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Preview" }).click();
  await expect(reloaded).toBeVisible();
  expect(
    await again
      .locator("body")
      .evaluate(() => document.documentElement.dataset.previewKept)
  ).toBe("1");
  await expect(address).toHaveValue("/kept-across-tabs");
  await expect(reloaded.getByRole("status")).toHaveAttribute(
    "aria-label",
    "Ready"
  );

  // Closing the panel stops the preview: the frame goes with it.
  await reloaded.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator('iframe[title="App preview"]')).toHaveCount(0);
});

test("Preview builds a Vite app without the Cloudflare plugin", async ({
  page,
  request,
}) => {
  createdApps.push(VITE_SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Preview Vite",
    slug: VITE_SLUG,
  });
  pushAppDir(apiKey, new URL("../test/vite", import.meta.url), VITE_SLUG);

  await page.goto(`/apps/${appId}/source?panel=preview`);
  const panel = page.getByRole("complementary", { name: "Preview" });
  await expect(panel).toBeVisible();
  const frame = page.frameLocator('iframe[title="App preview"]');
  // The built client: the assets fallback answers `/` with index.html, and the
  // client bundle's own fetch of `/api/greeting` — the Worker route — fills
  // the greeting in. The module graph, the fallback and the route all run
  // inside the frame, on the preview host.
  await expect(frame.locator("body")).toContainText("Vite on Noite", {
    timeout: 240_000,
  });
  await expect(frame.locator("#greeting")).toHaveText("hello from vite", {
    timeout: 60_000,
  });
  // The plan says it built with a generated config.
  await expect
    .poll(() =>
      panel.locator(".tooltip").evaluate((element) => element.dataset.tip)
    )
    .toContain(PREVIEW_NOTES.generatedViteConfig);
});
