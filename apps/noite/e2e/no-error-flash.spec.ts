import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createAppWithKey, deleteApp } from "./helpers";

// Owner feedback (2026-11-10): "when switching pages or tabs, the initial
// loading state is error. make sure I won't see errors for a fraction of a
// second first. error state should only be visible on actual errors."
//
// Every panel paints one `ResourceState`/`FeedState`: a resource that has not
// answered yet is `Loading` (a skeleton), a feed that has not connected yet is
// `Cold` — neither may render error text. This spec records every error-ish
// node that appears in the document (from the first script tick, so a
// server-rendered node is caught too) while it walks the pages and tabs, and
// fails naming the text and the step that painted it.

const SLUG = "no-error-flash";

/** Error-ish paint: an alert, an error alert, or the shared red problem
 * paragraph the resource/feed views render. A status dot (`status-error`) is a
 * legitimate app state and a destructive button is styled `text-error` on
 * purpose, so neither is listed. */
const ERROR_SELECTOR = '[role="alert"],.alert-error,p.text-error';

const APP_NAME = "No Error Flash";

interface ErrorFlash {
  readonly step: string;
  readonly text: string;
}

declare global {
  // eslint-disable-next-line no-var -- the probe is a browser global the spec reads back
  var __noiteErrorFlashes: ErrorFlash[] | undefined;
  // eslint-disable-next-line no-var -- the probe is a browser global the spec writes
  var __noiteMark: ((step: string) => void) | undefined;
}

/** Record every error-ish node from the document's first tick on. */
const watchForErrorFlashes = async (page: Page): Promise<void> => {
  await page.addInitScript((selector: string) => {
    const flashes: ErrorFlash[] = [];
    const seen = new WeakSet<Node>();
    let step = "load";

    const record = (node: Node): void => {
      if (seen.has(node)) {
        return;
      }

      seen.add(node);

      const text = (node.textContent ?? "").trim();

      if (text !== "") {
        flashes.push({ step, text });
      }
    };

    const inspect = (node: Node): void => {
      if (!(node instanceof Element)) {
        return;
      }

      if (node.matches(selector)) {
        record(node);
      }

      for (const match of node.querySelectorAll(selector)) {
        record(match);
      }
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          inspect(mutation.target);

          continue;
        }

        for (const node of mutation.addedNodes) {
          inspect(node);
        }
      }
    });

    observer.observe(document, {
      attributeFilter: ["class", "role"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    // The document's own first frame: nodes the parser already created before
    // this init script ran (the server-rendered HTML).
    document.addEventListener("DOMContentLoaded", () => {
      inspect(document.documentElement);
    });

    globalThis.__noiteErrorFlashes = flashes;
    globalThis.__noiteMark = (next: string) => {
      step = next;
    };
  }, ERROR_SELECTOR);
};

/** Name the step the next paint belongs to, so a failure is attributable. */
const mark = (page: Page, step: string): Promise<void> =>
  page.evaluate((next: string) => {
    globalThis.__noiteMark?.(next);
  }, step);

const expectNoFlash = async (page: Page, step: string): Promise<void> => {
  const seen = await page.evaluate(() => globalThis.__noiteErrorFlashes ?? []);

  expect(
    seen,
    `error text painted during ${step}: ${JSON.stringify(seen)}`
  ).toEqual([]);
};

const appLink = (page: Page) =>
  page.getByRole("link", { exact: true, name: APP_NAME }).first();

/** The page's feed connection is replaced whenever the visible feed set
 * changes — the moment the panel paints its loading state. Awaiting the
 * reopen keeps every step's check after that paint had its chance. */
const nextStreams = (page: Page) =>
  page.waitForResponse((response) => response.url().includes("/api/streams?"));

test("pages and tabs never paint an error before a load settles", async ({
  page,
  request,
}) => {
  await watchForErrorFlashes(page);

  const { appId } = await createAppWithKey(page, request, {
    name: APP_NAME,
    slug: SLUG,
  });

  try {
    // --- apps list ↔ app detail ------------------------------------------
    await mark(page, "apps list");
    const listStream = nextStreams(page);
    await page.goto("/apps");
    await listStream;
    await expect(page.getByText("Your Apps", { exact: true })).toBeVisible();
    await expect(appLink(page)).toBeVisible();
    await expectNoFlash(page, "apps list");

    await mark(page, "app overview");
    const overviewStream = nextStreams(page);
    await appLink(page).click();
    await overviewStream;
    await expect(page.locator("h1")).toHaveText(APP_NAME);
    await expectNoFlash(page, "app overview");

    // --- every tab -------------------------------------------------------
    // Tabs are visited one at a time: each click must settle before the next
    // one can prove that tab's own paint.
    /* oxlint-disable eslint/no-await-in-loop -- sequential UI steps */
    for (const name of [
      "Deployments",
      "Metrics",
      "Errors",
      "Events",
      "Overview",
    ]) {
      await mark(page, `${name} tab`);
      const stream = nextStreams(page);
      await page.getByRole("tab", { exact: true, name }).click();
      await stream;
      await expect(
        page.getByRole("tab", { exact: true, name })
      ).toHaveAttribute("aria-selected", "true");
      await expectNoFlash(page, `${name} tab`);
    }
    /* oxlint-enable eslint/no-await-in-loop */

    // --- back to the list and in again -----------------------------------
    await mark(page, "back to apps");
    const backStream = nextStreams(page);
    await page.goto("/apps");
    await backStream;
    await expect(page.getByText("Your Apps", { exact: true })).toBeVisible();
    await expectNoFlash(page, "back to apps");

    await mark(page, "app again");
    const againStream = nextStreams(page);
    await appLink(page).click();
    await againStream;
    await expect(page.locator("h1")).toHaveText(APP_NAME);
    await expectNoFlash(page, "app again");

    // --- a reload of a tab's URL (the document's first paint) -------------
    await mark(page, "reload on a tab");
    const reloadStream = nextStreams(page);
    await page.goto(`/apps/${appId}?t=events`);
    await reloadStream;
    await expect(
      page.getByRole("tab", { exact: true, name: "Events" })
    ).toHaveAttribute("aria-selected", "true");
    await expectNoFlash(page, "reload on a tab");
  } finally {
    await deleteApp(request, SLUG);
  }
});
