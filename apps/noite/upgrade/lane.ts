import { expect } from "@playwright/test";
import type {
  APIResponse,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";
import * as Schema from "effect/Schema";

import { E2E_EMAIL, E2E_NAME, addVirtualAuthenticator } from "../e2e/helpers";

/** POST a control JSON action with the page's session cookies and answer the
 * raw response. Playwright's request context sends no Origin or
 * Sec-Fetch-Site, which the control origin check explicitly allows, so these
 * calls work without a page navigation. */
export const postAction = async (
  page: Page,
  path: string,
  text: string
): Promise<APIResponse> => {
  const res = await page.request.post(path, {
    data: text,
    headers: { "content-type": "application/json" },
  });

  if (!res.ok()) {
    throw new Error(`${path} answered ${res.status()}: ${await res.text()}`);
  }

  return res;
};

/** Decode an action response through its schema: a shape change fails the
 * lane with the schema's error instead of a silent wrong read. */
export const apiObject = async <A, I>(
  page: Page,
  path: string,
  body: Record<string, number | string | boolean | null>,
  schema: Schema.Schema<A, I>
): Promise<A> => {
  const res = await postAction(page, path, JSON.stringify(body));

  return Schema.decodeUnknownSync(schema)(await res.json());
};

const { NonEmptyString } = Schema;

const KeyResponse = Schema.Struct({ key: NonEmptyString });
const IdResponse = Schema.Struct({ id: NonEmptyString });
const StatusResponse = Schema.Struct({ status: Schema.String });
const AppIdResponse = Schema.Struct({ appId: NonEmptyString });
const CodesResponse = Schema.Struct({ codes: Schema.Array(NonEmptyString) });
const CodeRow = Schema.Struct({ code: NonEmptyString, id: NonEmptyString });

const InvitationRow = Schema.Struct({
  appId: NonEmptyString,
  id: NonEmptyString,
});

const CollaboratorRow = Schema.Struct({ email: Schema.String });

/** Mint a profile API key for pushing to the seed app. Scopes match the UI
 * form's defaults (both on): the action refuses a key with neither scope. */
export const mintKey = async (page: Page, name: string): Promise<string> => {
  const created = await apiObject(
    page,
    "/api/account/createApiKey",
    {
      appManagement: true,
      events: true,
      name,
    },
    KeyResponse
  );

  return created.key;
};

/** Create the seed app through the control API (owned by the session
 * account, like the UI flow) and answer its id. */
export const createApp = async (
  page: Page,
  app: { name: string; slug: string }
): Promise<string> => {
  const created = await apiObject(page, "/api/apps/create", app, IdResponse);

  return created.id;
};

/** Invite one email to an app; answers the invitation's status. */
export const inviteCollaborator = async (
  page: Page,
  invite: { appId: string; email: string; role: string }
): Promise<string> => {
  const invited = await apiObject(
    page,
    "/api/collaborators/inviteCollaborator",
    invite,
    StatusResponse
  );

  return invited.status;
};

/** The seed app's pending invitation for the signed-in account. */
export const pendingInvitationId = async (
  page: Page,
  appId: string
): Promise<string> => {
  const res = await postAction(
    page,
    "/api/collaborators/myCollaboratorInvitations",
    "{}"
  );

  const pending = Schema.decodeUnknownSync(Schema.Array(InvitationRow))(
    await res.json()
  );

  const invitation = pending.find((candidate) => candidate.appId === appId);

  if (invitation === undefined) {
    throw new Error("no pending invitation for the seed app");
  }

  return invitation.id;
};

/** Accept an invitation by id; answers the app it granted. */
export const acceptInvitation = async (
  page: Page,
  inviteId: string
): Promise<string> => {
  const res = await postAction(
    page,
    "/api/collaborators/acceptInvitation",
    JSON.stringify(inviteId)
  );

  const accepted = Schema.decodeUnknownSync(AppIdResponse)(await res.json());

  return accepted.appId;
};

/** Whether an email is on the app's collaborator list. */
export const hasCollaborator = async (
  page: Page,
  appId: string,
  email: string
): Promise<boolean> => {
  const res = await postAction(
    page,
    "/api/collaborators/listCollaborators",
    JSON.stringify(appId)
  );

  const rows = Schema.decodeUnknownSync(Schema.Array(CollaboratorRow))(
    await res.json()
  );

  return rows.some((candidate) => candidate.email === email);
};

/** Register an account through the passkey ceremony and mark it onboarded.
 * The ceremony itself has no HTTP equivalent (WebAuthn needs a browser
 * authenticator), so this is the one UI step the lane keeps; everything
 * after it uses the stable `/api` and `/v1` surfaces, which is what keeps
 * the seed working against older images after a UI redesign. Onboarding
 * goes through the API; the tour clicks are only the fallback for an image
 * whose API lacks the endpoint. */
export const registerAccount = async (
  browser: Browser,
  account: { email: string; name: string; inviteCode?: string }
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });

  const page = await context.newPage();

  try {
    await addVirtualAuthenticator(page);
    await page.goto("/login");
    await page.getByRole("tab", { name: "Create account" }).click();
    await page.locator("#register-name").fill(account.name);
    await page.locator("#register-email").fill(account.email);

    if (account.inviteCode !== undefined) {
      await page.locator("#register-invite").fill(account.inviteCode);
    }

    await page.getByRole("button", { name: "Create passkey" }).click();
    await expect(async () => {
      const res = await page.request.get("/api/auth/get-session");

      // SAFETY: better-auth answers the session object or null; only the email is read.
      const session = (await res.json()) as {
        user?: { email?: string };
      };

      expect(session.user?.email).toBe(account.email);
    }).toPass({ timeout: 30_000 });

    let onboarded = false;

    try {
      await postAction(page, "/api/account/completeOnboarding", "{}");
      onboarded = true;
    } catch {
      onboarded = false;
    }

    if (!onboarded) {
      await page.goto("/apps");
      await page.locator("#onboarding-next").click();
      await page.locator("#onboarding-next").click();
      await page.locator("#onboarding-finish").click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }
  } catch (error) {
    await context.close();
    throw error;
  }

  return { context, page };
};

export const OWNER = { email: E2E_EMAIL, name: E2E_NAME };

/** A fresh invite code for a second account: the account's unused codes
 * first, else mint one (the lane account bootstraps as admin). */
export const readInviteCodeApi = async (page: Page): Promise<string> => {
  const listedRes = await postAction(page, "/api/account/myInviteCodes", "{}");

  const listed = Schema.decodeUnknownSync(Schema.Array(CodeRow))(
    await listedRes.json()
  );

  const known = listed.find((row) => row.code !== "");

  if (known !== undefined) {
    return known.code;
  }

  const minted = await apiObject(
    page,
    "/api/admin/adminCreateInvites",
    {
      count: 1,
    },
    CodesResponse
  );

  const [code] = minted.codes;

  if (code === undefined) {
    throw new Error("adminCreateInvites answered no code");
  }

  return code;
};
