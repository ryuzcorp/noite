import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createAppWithKey,
  deleteApp,
  registerInviteeWithFreshCode,
} from "./helpers";

// Removing an app collaborator is destructive, so the panel asks first: the
// dialog names the address and says what the removal costs. Esc and Cancel
// close it without a request, and only the dialog's own Remove button drops
// the grant — proven through the removed account's session, not just the
// row disappearing.
const SLUG = `collaborators-${Date.now()}`;

const prompt = (page: Page) => page.getByRole("alertdialog");

test("removing a collaborator asks first; Esc and Cancel keep the grant", async ({
  browser,
  page,
  request,
}) => {
  const { appId } = await createAppWithKey(page, request, {
    name: "Collaborators",
    slug: SLUG,
  });

  const email = `collab-${Date.now()}@example.com`;

  const invitee = await registerInviteeWithFreshCode(browser, page, {
    email,
    name: "Collab User",
  });

  try {
    await page.goto(`/apps/${appId}/settings?section=collaborators`);
    await page.getByRole("button", { exact: true, name: "Invite" }).click();
    await page.locator("#invite-email").fill(email);
    await page.locator("#invite-role").selectOption("view");
    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Invite" })
      .click();

    await invitee.page.goto("/apps");
    await invitee.page
      .getByRole("button", { exact: true, name: "Accept" })
      .click();
    await expect(invitee.page).toHaveURL(new RegExp(`/apps/${appId}`, "u"));

    await page.goto(`/apps/${appId}/settings?section=collaborators`);

    // The panel paints its last sessionStorage snapshot while it refetches
    // (lib/resource.ts), so an accepted invitation can still be on screen
    // for the first frames after the navigation. Wait for the fresh pending
    // list to drop it; accepting consumes the invitation server-side (see
    // collaborators.test.ts), so this is the refetch landing, not a grant
    // that the UI forgot to remove.
    const pendingRow = page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: "Revoke" }) });

    await expect(pendingRow).toBeHidden();

    // The member row is the one that offers Remove; the pending invitation
    // (while any snapshot still paints it) offers Revoke and would make a
    // hasText-only locator resolve to two elements.
    const row = page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: "Remove" }) })
      .filter({ hasText: email });

    await expect(row).toBeVisible();

    const remove = row.getByRole("button", { name: "Remove" });

    await remove.click();
    await expect(prompt(page)).toContainText(email);
    await expect(prompt(page)).toContainText("loses access to this app");
    await page.keyboard.press("Escape");
    await expect(prompt(page)).toBeHidden();
    await expect(row).toBeVisible();

    await remove.click();
    await prompt(page)
      .getByRole("button", { exact: true, name: "Cancel" })
      .click();
    await expect(prompt(page)).toBeHidden();
    await expect(row).toBeVisible();

    await remove.click();
    await prompt(page)
      .getByRole("button", { exact: true, name: "Remove" })
      .click();
    await expect(row).toBeHidden();

    const denied = await invitee.page.request.post(
      "/api/collaborators/listCollaborators",
      { data: JSON.stringify(appId) }
    );

    expect(denied.status()).toBe(401);
  } finally {
    await invitee.context.close();
    await deleteApp(request, SLUG);
  }
});
