import { test as setup } from "@playwright/test";

import { OWNER, registerAccount } from "./lane";

const authFile = process.env.E2E_AUTH_DIR
  ? `${process.env.E2E_AUTH_DIR}/user.json`
  : "upgrade/.auth/user.json";

/** Register the upgrade lane's account and persist the session: the seed
 * and the verify run in two separate Playwright invocations, and both
 * read this session. Registration is the lane's one UI step (see lane.ts);
 * the account must already exist before any `/api` call in the seed. */
setup.skip(
  process.env.UPGRADE_PHASE === "verify",
  "the verify phase reuses the seed phase's session"
);

setup("register upgrade account", async ({ browser }) => {
  const { context, page } = await registerAccount(browser, OWNER);

  try {
    await page.context().storageState({ path: authFile });
  } finally {
    await context.close();
  }
});
