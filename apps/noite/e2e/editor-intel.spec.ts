import { expect, test } from "@playwright/test";

import { createAppWithKey, deleteApp, pushAppDir } from "./helpers";

// Code intelligence in the browser editor (Files view): the language-service
// worker turns typing into markers, hover into a tooltip, and Cmd/Ctrl+click
// into a jump to another file in the repo. Everything asserted here is what a
// user sees — pierre renders into an open shadow root, which Playwright's CSS
// and role locators pierce.
//
// The fixture (`./fixtures/intel`) is a self-contained TypeScript module pair
// with its own `tsconfig.json`: no dependency, no build, so nothing here waits
// on a deploy — the files come from the push mirror, and the language service
// needs the repo alone (`?ref=main` is the default branch, hence editable).

const SLUG = "editor-intel";

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

test("the editor reports diagnostics, hover and go-to-definition", async ({
  page,
  request,
}) => {
  createdApps.push(SLUG);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "Editor Intel",
    slug: SLUG,
  });
  pushAppDir(apiKey, new URL("fixtures/intel", import.meta.url), SLUG);

  await page.goto(`/apps/${appId}/source?file=index.ts&ref=main`);
  // Pierre renders the editor's content element as the `<pre>` it flips to
  // `contenteditable="true"`; everything lives in open shadow roots, which
  // these locators pierce.
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  // The rendered code: the `<pre>` that carries pierre's token spans. Reading
  // is never blocked by the language service — a broken worker must not take
  // the pane down with it, so the file's own text stays on screen.
  const rendered = page
    .locator("pre")
    .filter({ has: page.locator("[data-char]") })
    .first();
  await expect(rendered).toContainText("describe");

  // Hover: the tooltip shows the symbol's type, computed by the language
  // service worker from the repository's own sources.
  await page
    .locator("span[data-char]", { hasText: /^Label$/u })
    .first()
    .hover();
  await expect(page.getByRole("tooltip")).toHaveText(/interface\s+Label/u, {
    timeout: 30_000,
  });

  // A type error typed into the editor comes back as a marker carrying the
  // TypeScript message. The fixture is clean, so exactly one marker appears —
  // which is also the proof that the repo's own `tsconfig.json` was honoured.
  const box = await editor.boundingBox();
  if (box === null) {
    throw new TypeError("the editor has no box");
  }
  // The pane stretches past the text: clicking below the last line focuses the
  // content element (a click on a line is pierre's, and it does not take focus).
  await editor.click({ position: { x: 8, y: box.height - 8 } });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type('const bad: number = "oops";');
  const markers = page.locator("[data-marker-range][data-marker-error]");
  await expect(markers).toHaveCount(1, { timeout: 30_000 });
  // Hovering the squiggle is how a user reads the message — but the squiggle
  // is a pointer-events-free overlay, so this is a raw mouse move over it: the
  // text underneath is what pierre listens to.
  const markerBox = await markers.first().boundingBox();
  if (markerBox === null) {
    throw new TypeError("the marker has no box");
  }
  await page.mouse.move(
    markerBox.x + markerBox.width / 2,
    markerBox.y + markerBox.height / 2
  );
  await expect(page.locator("[data-marker-message]")).toContainText("TS2322", {
    timeout: 30_000,
  });

  // Cmd/Ctrl+click an imported symbol: the file that declares it opens (and
  // the caret is asked for at the definition — pierre delivers that focus on
  // its next render tick, so this asserts the file switch, which is what the
  // user sees happen).
  await page
    .locator("span[data-char]", { hasText: /^format$/u })
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(/file=util\.ts/u, { timeout: 30_000 });
  await expect(rendered).toContainText("export interface Label");
});
