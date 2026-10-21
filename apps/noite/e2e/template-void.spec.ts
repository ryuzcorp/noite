import { expect, test } from "@playwright/test";

import {
  appListenPort,
  deleteApp,
  findAppId,
  waitForCreatedApp,
  waitForDeploy,
} from "./helpers";

const TEMPLATE_SLUG = "ilha-void";

/** Every app this spec creates, dropped afterwards: the account's app quota
 * (10) is shared by the whole lane, and a leftover slug fails the next run's
 * create on it. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

// The Ilha + Void template (`ryuzcorp/noite-template-oxide`): picked in the
// creator, deployed like any other app, serving SSR plus a server action on
// celld. A broken template fails this spec, which fails the release gate.
test("the Ilha + Void template deploys and serves", async ({
  page,
  request,
}) => {
  createdApps.push(TEMPLATE_SLUG);

  await page.goto("/apps/new");
  await page.getByRole("radio", { name: /^Template/u }).check();
  await page.getByRole("radio", { name: /Ilha \+ Void/u }).check();
  // The picker prefills Name and Slug from the template (the slug from its id).
  await expect(page.locator("#create-name")).toHaveValue("Ilha + Void");
  await expect(page.locator("#create-slug")).toHaveValue(TEMPLATE_SLUG);
  await page.getByRole("button", { name: "Create app" }).click();
  await waitForCreatedApp(page);

  const appId = await findAppId(request, TEMPLATE_SLUG);
  expect(appId).not.toBeNull();
  const id = appId ?? "";

  const deploy = await waitForDeploy(request, id);
  expect(deploy.status, deploy.log).toBe("success");
  // The template installs with bun and deploys the config its build wrote.
  expect(deploy.log).toContain("▸ install: bun install (bun.lock)");
  expect(deploy.log).toContain("▸ build: bun run build");
  expect(deploy.log).toContain("config: dist/wrangler.json (build output)");

  const base = `http://localhost:${await appListenPort(request, id)}`;
  // A first deploy spawns the fleet; its port resets connections until
  // celld listens.
  await expect
    .poll(
      async () => {
        const res = await request.get(`${base}/`).catch(() => null);
        const text = res?.ok() ? await res.text().catch(() => null) : null;

        return text?.includes("Ilha + Void on Noite") ? text : null;
      },
      { intervals: [1000], timeout: 60_000 }
    )
    .toContain("Render a page with Void and Ilha");

  // Pre-hydration race regression (flake CI run 39514830134): the page is
  // server-rendered with the form in place, but the controlled input and
  // submit handler exist only after the client hydrates — a fill or click
  // before that was lost (the Add click fell back to a native GET submit to
  // /?text=…, and the todo never appeared). The template keeps its controls
  // disabled until the client mounts, so drivers wait instead. Client
  // scripts are held behind a promise the test resolves itself (no timers):
  // while held, the server-rendered input, Add button and island counter
  // must already be disabled; after release the test drives the page as a
  // user would.
  let gate: Promise<unknown> = Promise.resolve();
  let releaseGate: (() => void) | undefined;

  const holdScripts = (): void => {
    const deferred = Promise.withResolvers();

    gate = deferred.promise;
    releaseGate = deferred.resolve;
  };

  // Arm the held-scripts gate for one guarded navigation. The previous
  // section's gate is released and unrouted first: a request held for the
  // old page must never survive the navigation. Continuing it afterwards
  // is a silent no-op (no response, no error), which wedged the island
  // counter in CI run 39535601008: old-page scripts parked on the new
  // gate stayed `pending` after release and hydration never ran.
  const guardScripts = async (): Promise<void> => {
    releaseGate?.();
    await page.unroute("**/*.js");
    holdScripts();
    await page.route("**/*.js", async (route) => {
      await gate;
      await route.continue();
    });
  };

  await guardScripts();

  // The server action: adding a todo from the browser, through the Worker.
  await page.goto(`${base}/`, { waitUntil: "commit" });
  const todoInput = page.getByLabel("New todo");
  const addButton = page.getByRole("button", { name: "Add" });
  await expect(todoInput).toBeDisabled();
  await expect(addButton).toBeDisabled();
  releaseGate?.();
  await expect(
    page.getByRole("heading", { name: "Ilha + Void on Noite" })
  ).toBeVisible();
  await todoInput.fill("Serve on celld");
  await addButton.click();
  await expect(page.locator("li", { hasText: "Serve on celld" })).toBeVisible();

  // The island page serves static HTML with a working counter island.
  await guardScripts();
  await page.goto(`${base}/about`, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  const counter = page.getByRole("button", { name: /Clicked \d+ times/u });
  await expect(counter).toBeDisabled();
  await expect(counter).toContainText("Clicked 1 times");
  releaseGate?.();
  await counter.click();
  await expect(counter).toContainText("Clicked 2 times");
});
