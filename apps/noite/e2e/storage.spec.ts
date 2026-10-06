import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { E2E_SLUG, appListenPort, findAppId, readSampleApp } from "./helpers";

// The sample app (apps/noite/test) binds R2 `uploads`, the `Counter` Durable
// Object and D1 `demo`, so this spec proves the storage views against a real
// Worker: the runner's listing/upload/delete go through `celld r2 put|delete`,
// and the app's own `env.FILES.get` is the referee for every write.
//
// Runs after deploy.spec.ts (specs run alphabetically, one worker): that spec
// creates the `e2e` app and pushes the sample. If the app is missing the
// dependency broke — fail loudly instead of recreating it.

const R2_ROOT = (appId: string): string =>
  `/storage/${appId}/${encodeURIComponent("r2:uploads")}`;

const DO_COUNTER = (appId: string): string =>
  `/storage/${appId}/${encodeURIComponent("do:COUNTER:Counter")}`;

const tenant = (port: number): string => `http://localhost:${port}`;

const e2eApp = async (request: APIRequestContext): Promise<string> => {
  const appId = await findAppId(request, E2E_SLUG);
  if (appId === null) {
    throw new Error(
      `app ${E2E_SLUG} is missing — deploy.spec.ts must run (and pass) first`
    );
  }
  return appId;
};

/** The detail column (R2 and DO views share the labelled shell). */
const details = (page: Page) =>
  page.getByRole("complementary", { name: "Details" });

test("the overview lists the app's storage resources by id", async ({
  page,
  request,
}) => {
  const appId = await e2eApp(request);
  await page.goto(`/apps/${appId}`);
  // The id the storage route parses: `{kind}:{name}` (DO adds its binding).
  await expect(
    page.getByRole("link", { exact: true, name: "uploads" })
  ).toHaveAttribute("href", new RegExp(`/storage/${appId}/r2%3Auploads$`, "u"));
  await expect(
    page.getByRole("link", { exact: true, name: "Counter" })
  ).toHaveAttribute(
    "href",
    new RegExp(`/storage/${appId}/do%3ACOUNTER%3ACounter$`, "u")
  );
  await expect(
    page.getByRole("link", { exact: true, name: "demo" })
  ).toHaveAttribute("href", new RegExp(`/storage/${appId}/d1%3Ademo$`, "u"));
});

test("a Worker-written object appears in the browser with its type", async ({
  page,
  request,
}) => {
  const appId = await e2eApp(request);
  const port = await appListenPort(request, appId);

  // Worker -> R2: GET /upload-test-txt stores test.txt as text/plain.
  const written = await request.get(`${tenant(port)}/upload-test-txt`);
  expect(written.ok()).toBe(true);

  await page.goto(R2_ROOT(appId));
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("uploads");

  const row = page.getByRole("row", { name: /test\.txt/u });
  await expect(row).toBeVisible();
  await expect(row).toContainText("text/plain");

  await row.click();
  await expect(page.getByRole("heading", { name: "test.txt" })).toBeVisible();
  await expect(details(page)).toContainText("text/plain");
  await expect(details(page)).toContainText("hello from noite test app");
});

test("uploading and deleting round-trips through the Worker", async ({
  page,
  request,
}) => {
  const appId = await e2eApp(request);
  const port = await appListenPort(request, appId);

  await page.goto(R2_ROOT(appId));

  // New folder, with a space in the name: the key celld has to encode.
  await page
    .locator("details", { hasText: "New folder" })
    .locator("summary")
    .click();
  await page.locator("#r2-new-folder").fill("my docs");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: "my docs" })).toBeVisible();
  await expect(page.getByText(/Folder .my docs. created/u)).toBeVisible();

  // Enter it and upload a file whose key contains that space.
  await page.getByRole("link", { name: "my docs" }).click();
  await expect(page).toHaveURL(/p=my%20docs%2F/u);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      buffer: Buffer.from("noite e2e note\n"),
      mimeType: "text/plain",
      name: "note.txt",
    });

  const row = page.getByRole("row", { name: /note\.txt/u });
  await expect(row).toBeVisible();
  await expect(row).toContainText("text/plain");

  // The referee: the app's own binding reads back exactly what was uploaded.
  const roundTrip = await request.get(
    `${tenant(port)}/files/${encodeURIComponent("my docs/note.txt")}`
  );
  expect(roundTrip.ok()).toBe(true);
  expect(await roundTrip.text()).toBe("noite e2e note\n");
  expect(roundTrip.headers()["content-type"]).toContain("text/plain");

  // Bulk delete from the UI, then the Worker cannot find it any more.
  await page.getByRole("checkbox", { name: "Select note.txt" }).check();
  await page.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.getByText(/Delete 1 object\(s\)\?/u)).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.getByRole("row", { name: /note\.txt/u })).toBeHidden();

  const gone = await request.get(
    `${tenant(port)}/files/${encodeURIComponent("my docs/note.txt")}`
  );
  expect(gone.status()).toBe(404);

  // Single delete from the detail panel (test.txt was written by the first
  // storage test); back at the bucket root it is visible again.
  await page.goto(R2_ROOT(appId));
  const testRow = page.getByRole("row", { name: /test\.txt/u });
  await expect(testRow).toBeVisible();
  await testRow.click();
  await details(page)
    .getByRole("button", { exact: true, name: "Delete" })
    .click();
  await expect(details(page).getByText("Delete this file?")).toBeVisible();
  await details(page)
    .getByRole("button", { exact: true, name: "Delete" })
    .click();
  await expect(page.getByRole("row", { name: /test\.txt/u })).toBeHidden();

  const testGone = await request.get(`${tenant(port)}/files/test.txt`);
  expect(testGone.status()).toBe(404);
});

test("the Durable Object view reads the instance's stored state", async ({
  page,
  request,
}) => {
  const appId = await e2eApp(request);
  const port = await appListenPort(request, appId);

  // Calling the app advances the Counter and creates/adopts its instance.
  const visited = await request.get(`${tenant(port)}/`);
  expect(visited.ok()).toBe(true);
  // Read-only probe (?read=1 never advances the count).
  const { n } = await readSampleApp(request, port);
  expect(Number.isInteger(n)).toBe(true);

  await page.goto(DO_COUNTER(appId));
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("Durable Objects");
  await expect(crumbs).toContainText("Counter");
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();

  const row = page
    .getByRole("row", { name: new RegExp(`n=${n}`, "u") })
    .first();
  await expect(row).toBeVisible();
  await row.click();

  const panel = details(page);
  const valueRow = panel
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { exact: true, name: "n" }) });
  await expect(valueRow).toBeVisible();
  await expect(valueRow).toContainText(String(n));
  await expect(panel).toContainText("Read-only. celld keeps an instance's");

  // The read probe never advances the count: the stored value is unchanged.
  const after = await readSampleApp(request, port);
  expect(after.n).toBe(n);
});
