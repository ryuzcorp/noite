import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  deleteApp,
  pushAppDir,
  readSampleApp,
  runnerCall,
  waitForDeploy,
} from "./helpers";

// The sample app (apps/noite/test) binds R2 `uploads`, the `Counter` Durable
// Object and D1 `demo`, so this spec proves the storage views against a real
// Worker: the runner's listing/upload/delete go through `celld r2 put|delete`,
// the D1 editor writes go through the runner's D1 endpoints, and the app's
// own `env.FILES.get` is the referee for every R2 write while the runner's
// D1 rows endpoint referees every D1 write.
//
// Hermetic: the spec deploys its own copy of the sample (in the first test)
// instead of borrowing deploy.spec.ts's `e2e` app, so files may
// run in parallel in any order.

const SLUG = "storage-e2e";

const R2_ROOT = (appId: string): string =>
  `/storage/${appId}/${encodeURIComponent("r2:uploads")}`;

const D1_ROOT = (appId: string): string =>
  `/storage/${appId}/${encodeURIComponent("d1:demo")}`;

const DO_COUNTER = (appId: string): string =>
  `/storage/${appId}/${encodeURIComponent("do:COUNTER:Counter")}`;

const tenant = (port: number): string => `http://localhost:${port}`;

let deployedAppId: string | null = null;

test.afterAll(async ({ request }) => {
  await deleteApp(request, SLUG);
  deployedAppId = null;
});

const storageApp = (): string => {
  if (deployedAppId === null) {
    throw new Error("storage-e2e app was not deployed by the first test");
  }

  return deployedAppId;
};

/** The detail column (R2 and DO views share the labelled shell). */
const details = (page: Page) =>
  page.getByRole("complementary", { name: "Details" });

test("the overview lists the app's storage resources by id", async ({
  page,
  request,
}) => {
  // Hermetic: the file deploys its own copy of the sample here (tests run
  // serially within a file, so the later tests reuse it) instead of
  // borrowing deploy.spec.ts's `e2e` app — `page` is unavailable in
  // beforeAll, and the app must be created through the UI.
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Storage E2E",
    slug: SLUG,
  });

  pushAppDir(apiKey, new URL("../test", import.meta.url), SLUG);
  const deploy = await waitForDeploy(request, appId);
  expect(deploy.status).toBe("success");
  deployedAppId = appId;

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
  const appId = storageApp();
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
  const appId = storageApp();
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
  // The folder view remounts keyed by prefix a tick after the URL flips: wait
  // for its own empty state, or the upload below fires on the still-mounted
  // root view's input (whose prefix is "") and the object lands outside the
  // folder.
  await expect(
    page.getByText("This folder is empty — upload a file into it.")
  ).toBeVisible();
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
  const appId = storageApp();
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

/** The referee for every D1 edit below: the runner's D1 rows endpoint reads
 * exactly what the tenant Worker stored, so a UI write the runner cannot see
 * never counts as proven. */
const d1CountBySearch = async (
  request: APIRequestContext,
  appId: string,
  search: string
): Promise<number> => {
  const { body, status } = await runnerCall(
    request,
    `/v1/apps/${appId}/storage/d1/demo/tables/visits/rows`,
    {
      body: {
        filters: [],
        page: 0,
        page_size: 25,
        search,
        sort: null,
        table: "visits",
      },
      method: "POST",
    }
  );

  expect(status).toBe(200);

  // SAFETY: the runner's D1 rows route answers the generated D1Rows shape
  // (table, columns, rows, total, page, pageSize); the Array check rejects
  // anything else before the rows are counted.
  const rowsPage = body as { rows?: unknown };

  if (!Array.isArray(rowsPage.rows)) {
    throw new TypeError(`unexpected D1 rows shape: ${JSON.stringify(body)}`);
  }

  return rowsPage.rows.length;
};

/** The referee's count as a pollable signal (a committed write is visible on
 * the next read, so the poll only absorbs propagation). */
const pollD1Count =
  (
    request: APIRequestContext,
    appId: string,
    search: string
  ): (() => Promise<number>) =>
  () =>
    d1CountBySearch(request, appId, search);

/** Fill the visits row editor's two writable columns (`id` is an
 * autoincrement PK the insert omits, so only `ts` and `url` need values). */
const fillVisitsEditor = async (page: Page, url: string): Promise<void> => {
  await page.locator("#d1-field-visits-ts").fill("2026-10-21T00:00:00.000Z");
  await page.locator("#d1-field-visits-url").fill(url);
};

/** Insert one visits row through the UI row editor (dialog open, fill, save,
 * close); the bulk test calls this twice in sequence. */
const insertVisitsRow = async (page: Page, url: string): Promise<void> => {
  await page.getByRole("button", { name: "Insert" }).click();
  await expect(page.getByRole("heading", { name: "Insert row" })).toBeVisible();
  await fillVisitsEditor(page, url);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Row created").last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Insert row" })).toBeHidden();
};

/** Open the visits table and prove the table tab is showing its grid. */
const openVisits = async (page: Page, appId: string): Promise<void> => {
  await page.goto(`${D1_ROOT(appId)}?table=visits`);
  await expect(page.getByRole("tab", { name: /visits/u })).toBeVisible();
};

/** Open one visits row in the editor by clicking its url cell text. A click
 * on the row's center can land on the hover-revealed per-cell Copy button,
 * which stops propagation and copies instead of opening the row. */
const openVisitRow = async (page: Page, url: string): Promise<void> => {
  await page.getByText(url, { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Update row" })).toBeVisible();
};

test("tenant D1 rows insert, edit and single-delete through the editor", async ({
  page,
  request,
}) => {
  const appId = storageApp();
  const inserted = "https://e2e.invalid/d1-alpha";
  const edited = "https://e2e.invalid/d1-beta";
  await openVisits(page, appId);

  // The search box is the only way to isolate one row: every tenant request
  // appends a visits row, so the table always holds other writers' rows.
  const search = page.getByRole("searchbox", { name: "Search rows" });
  await search.fill(inserted);
  await expect(page.getByText("This table has no rows.")).toBeVisible();

  // Insert through the UI row editor; the PK input stays untouched so the DDL
  // default assigns it.
  await page.getByRole("button", { name: "Insert" }).click();
  await expect(page.getByRole("heading", { name: "Insert row" })).toBeVisible();
  await fillVisitsEditor(page, inserted);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Row created")).toBeVisible();
  await expect(page.getByRole("row", { name: /d1-alpha/u })).toBeVisible();

  // The referee: the runner's D1 rows endpoint sees exactly the inserted row.
  await expect.poll(pollD1Count(request, appId, inserted)).toBe(1);

  // Edit that same row: open it from the grid, change only the url, save.
  await openVisitRow(page, inserted);
  await page.locator("#d1-field-visits-url").fill(edited);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Row updated")).toBeVisible();

  await expect.poll(pollD1Count(request, appId, edited)).toBe(1);
  const staleCount = await d1CountBySearch(request, appId, inserted);
  expect(staleCount).toBe(0);

  // Single delete from the row editor's inline confirm.
  await search.fill(edited);
  await expect(page.getByRole("row", { name: /d1-beta/u })).toBeVisible();
  await openVisitRow(page, edited);
  await page.getByRole("button", { name: "Delete row" }).click();
  await expect(page.getByText(/Delete row where/u)).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.getByText("Row deleted")).toBeVisible();

  await expect(page.getByText("This table has no rows.")).toBeVisible();
  await expect.poll(pollD1Count(request, appId, edited)).toBe(0);
});

test("tenant D1 rows bulk-delete through the grid selection", async ({
  page,
  request,
}) => {
  const appId = storageApp();
  const first = "https://e2e.invalid/d1-bulk-1";
  const second = "https://e2e.invalid/d1-bulk-2";
  await openVisits(page, appId);

  await insertVisitsRow(page, first);
  await insertVisitsRow(page, second);

  await expect.poll(pollD1Count(request, appId, "d1-bulk")).toBe(2);

  await page.getByRole("searchbox", { name: "Search rows" }).fill("d1-bulk");
  // The search commits through a 300ms debounce and remounts the grid: the
  // rows below are already visible on the pre-commit grid, so the committed
  // query in the URL is the only signal the check is safe — a check on the
  // old grid is wiped by the remount and "2 selected" never appears.
  await expect(page).toHaveURL(/q=d1-bulk/u);
  await expect(page.getByRole("row", { name: /d1-bulk-1/u })).toBeVisible();
  await expect(page.getByRole("row", { name: /d1-bulk-2/u })).toBeVisible();

  await page
    .getByRole("checkbox", { name: "Select all rows on this page" })
    .check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.getByText(/Delete 2 row\(s\)\?/u)).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.getByText("2 rows deleted")).toBeVisible();
  await expect(page.getByText("This table has no rows.")).toBeVisible();

  // The referee: neither bulk-inserted row survives in the tenant database.
  await expect.poll(pollD1Count(request, appId, "d1-bulk")).toBe(0);
});

test("the D1 definition view shows the schema without write controls", async ({
  page,
}) => {
  const appId = storageApp();
  await page.goto(`${D1_ROOT(appId)}?table=visits&view=definition`);
  await expect(page.getByRole("heading", { name: "Columns" })).toBeVisible();
  await expect(page.getByText(/CREATE TABLE visits/u)).toBeVisible();
  // The definition view renders no toolbar, so no search, sort, filter or
  // Insert control can write from here.
  await expect(page.getByRole("button", { name: "Insert" })).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", { name: "Search rows" })
  ).toHaveCount(0);
});

test("the Durable Object view offers no write controls", async ({ page }) => {
  const appId = storageApp();
  await page.goto(DO_COUNTER(appId));
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Insert" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload" })).toHaveCount(0);

  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
