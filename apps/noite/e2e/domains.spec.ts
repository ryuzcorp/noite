import { expect, test } from "@playwright/test";

import { createAppWithKey, deleteApp } from "./helpers";

// Custom-domain ownership: the lane has no controllable DNS, so this covers
// the UI flow that needs no real record — claim a hostname, see its status
// and TXT instructions, watch Verify fail readably (no record), and remove
// it. The runner logic behind Verify (token match, first-to-verify-wins,
// pending-mints-nothing) is covered by the runner's fake-resolver tests.
// The lane's tenancy decides the shape: `make e2e` runs `single`
// (claims verify at once), `make e2e-isolation` runs `multi` (pending +
// TXT proof + Verify).
const SLUG = `domains-${Date.now()}`;
const HOST = `${SLUG}.example.com`;
const MULTI = process.env.E2E_TENANCY === "multi";

test(
  "custom domain claim shows its status and verifies or fails readably",
  { tag: "@isolation" },
  async ({ page, request }) => {
    const { appId } = await createAppWithKey(page, request, {
      name: "Domains",
      slug: SLUG,
    });

    try {
      await page.goto(`/apps/${appId}?panel=settings`);
      await page.locator("#custom-domain-hostname").fill(HOST);
      await page.getByRole("button", { name: "Add domain" }).click();

      const row = page.locator("li", { hasText: HOST });

      if (MULTI) {
        await expect(row.getByText("Pending")).toBeVisible();
        await expect(row.getByText(`_noite-challenge.${HOST}`)).toBeVisible();
        await row.getByRole("button", { name: "Verify" }).click();
        // No record exists for this name: the lookup fails, and the panel
        // shows the runner's reason instead of a generic error.
        await expect(
          page.getByText(/no TXT record|DNS lookup failed/u)
        ).toBeVisible();
      } else {
        await expect(row.getByText("Verified")).toBeVisible();
      }

      await row.getByRole("button", { name: "Remove" }).click();
      await expect(page.getByText("No custom hostnames yet.")).toBeVisible();
    } finally {
      await deleteApp(request, SLUG);
    }
  }
);
