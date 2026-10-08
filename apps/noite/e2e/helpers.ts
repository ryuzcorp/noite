import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { sleep } from "$lib/sleep";
import { expect } from "@playwright/test";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from "@playwright/test";

export const E2E_EMAIL = "e2e@noite.local";
export const E2E_NAME = "E2E";
export const E2E_SLUG = "e2e";

const uiBaseURL = process.env.E2E_BASE_URL ?? "http://localhost:8090";
const apiBase = process.env.E2E_API_BASE ?? "http://localhost:8080";
const gitBase = process.env.E2E_GIT_BASE ?? "http://localhost:8080/v1/git";
const tenantBase = (port: number): string => `http://localhost:${port}`;

const runnerToken = (): string => {
  const token = process.env.E2E_RUNNER_TOKEN ?? "";
  if (!token) {
    throw new Error("E2E_RUNNER_TOKEN is not set");
  }
  return token;
};

interface RunnerApp {
  id: string;
  slug: string;
  status: string;
  listenPort: number | null;
}

interface RunnerDeploy {
  sha: string | null;
  status: string;
  log: string;
}

/** Attach a virtual WebAuthn authenticator (USB, resident key, verified)
 * so passkey registration works headless. Standard CDP practice — no app
 * changes, no extra services. */
export const addVirtualAuthenticator = async (page: Page): Promise<void> => {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      automaticPresenceSimulation: true,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      protocol: "ctap2",
      transport: "usb",
    },
  });
};
/** Authenticated runner call (raw-port lane: direct on :8080). The runner is
 * the platform's API, so feature checks that do not need a browser belong
 * here — the app-detail panels are a known-broken surface (see SPEC.md). */
export const runnerCall = async (
  request: APIRequestContext,
  path: string,
  init: { body?: unknown; method?: "GET" | "POST" | "DELETE" | "PATCH" } = {}
): Promise<{
  body: Record<string, never> | unknown[] | string | number | boolean | null;
  status: number;
}> => {
  const res = await request.fetch(`${apiBase}${path}`, {
    data: init.body,
    headers: { authorization: `Bearer ${runnerToken()}` },
    method: init.method ?? "GET",
  });
  // Success bodies are JSON, error bodies (and 204) are plain text: read the
  // text and parse what parses, so a caller asserting on an error message
  // reads the runner's words instead of a swallowed `null`.
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Plain-text body: keep it as-is.
  }
  // SAFETY: the runner answers `{ body }`-less JSON on success and plain text
  // on 204/error; either value fits the union this helper advertises.
  return {
    body: parsed as
      | Record<string, never>
      | unknown[]
      | string
      | number
      | boolean
      | null,
    status: res.status(),
  };
};

/** Runner API call direct on :8080 (raw-port lane, no edge). */
export const runnerApi = async <T>(
  request: APIRequestContext,
  path: string
): Promise<T> => {
  const res = await request.get(`${apiBase}${path}`, {
    headers: { authorization: `Bearer ${runnerToken()}` },
  });
  if (!res.ok) {
    throw new Error(`runner ${path}: ${res.status()} ${await res.text()}`);
  }
  // SAFETY: the runner returns raw JSON objects matching the caller's shape (runnerFetch contract — never a { body } envelope).
  return (await res.json()) as T;
};
export const findAppId = async (
  request: APIRequestContext,
  slug: string
): Promise<string | null> => {
  const apps = await runnerApi<RunnerApp[]>(request, "/v1/apps");
  return apps.find((app) => app.slug === slug)?.id ?? null;
};

/** Delete an app by slug, waiting for the runner to drop it. Specs clean up
 * the apps they create: the account's app quota (10) is shared by a whole
 * lane run, and a leftover app also poisons the next run's create. */
export const deleteApp = async (
  request: APIRequestContext,
  slug: string
): Promise<void> => {
  const appId = await findAppId(request, slug);
  if (appId === null) {
    return;
  }
  await runnerCall(request, `/v1/apps/${appId}`, { method: "DELETE" });
};

/** Tenant listen port for raw-port traffic (published 8100-8199). */
export const appListenPort = async (
  request: APIRequestContext,
  appId: string
): Promise<number> => {
  const app = await runnerApi<RunnerApp>(request, `/v1/apps/${appId}`);
  const { listenPort } = app;
  if (listenPort === null || listenPort === undefined) {
    throw new TypeError(`app ${appId} has no listen port yet`);
  }
  return listenPort;
};

/** Deploy status poll interval: the runner API is local and a status read is
 * one row, so a short interval only trims the wait after a deploy ends. */
export const DEPLOY_POLL_MS = 1000;

/** Poll deploys until the tip reaches a terminal status. Push fast-path
 * spawns within seconds; the reconcile tip poll is the fallback. */
export const waitForDeploy = async (
  request: APIRequestContext,
  appId: string,
  timeoutMs = 8 * 60_000
): Promise<RunnerDeploy> => {
  const start = Date.now();
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential deploy poll with early exit; Promise.all would defeat it
    const deploys = await runnerApi<RunnerDeploy[]>(
      request,
      `/v1/apps/${appId}/deploys`
    );
    const [latest] = deploys;
    if (latest && (latest.status === "success" || latest.status === "failed")) {
      return latest;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`deploy for ${appId} did not finish in ${timeoutMs}ms`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
    await sleep(DEPLOY_POLL_MS);
  }
};

/** Mint an API key on the signed-in account's Account page. The raw key is
 * shown exactly once, so it is read from that one screen. */
export const mintApiKey = async (
  page: Page,
  label: string
): Promise<string> => {
  await page.goto("/account");
  await page
    .locator('button[type="button"]', { hasText: "Create key" })
    .click();
  await page.locator("#key-name").fill(label);
  await page
    .locator('button[type="submit"]', { hasText: "Create key" })
    .click();
  await page.locator("text=Copy now — shown once").waitFor({ timeout: 30_000 });
  const raw = await page.locator("code.break-all").first().textContent();
  const apiKey = raw?.trim() ?? "";
  if (apiKey.length === 0) {
    throw new Error("no API key shown after Create key");
  }
  return apiKey;
};

/** One of the signed-in account's unused invite codes: the Account page lists
 * the share registration minted for it. When the share is used up (every
 * spec that registers a second account spends one), the admin mints one more
 * on the admin Invites tab instead of waiting on a code that never appears. */
export const readInviteCode = async (page: Page): Promise<string> => {
  const invitesCard = page.locator("div.card", {
    has: page.getByRole("heading", { name: "Invitations" }),
  });
  await page.goto("/account");
  await expect(invitesCard).toBeVisible();
  if ((await invitesCard.locator("code").count()) === 0) {
    await page.goto("/apps/_control?t=invites");
    await page.locator("#invite-count").fill("1");
    await page.getByRole("button", { exact: true, name: "Generate" }).click();
    await expect(page.locator("#admin-invite-search")).toBeVisible();
    await page.goto("/account");
  }
  const raw = await invitesCard
    .locator("code")
    .first()
    .textContent({ timeout: 15_000 });
  const code = raw?.trim() ?? "";
  if (code === "") {
    throw new Error("no invite code on the Account page");
  }
  return code;
};

/** Register a second account with `inviteCode` in a browser context of its
 * own (virtual authenticator, onboarding dismissed, on /apps). The caller
 * owns the context and closes it. */
export const registerInviteeAccount = async (
  browser: Browser,
  inviteCode: string,
  email: string,
  name: string
): Promise<{ context: BrowserContext; page: Page }> => {
  // Signed out: inside a test, newContext() inherits the project's
  // storageState, which would open this context as the e2e admin.
  const context = await browser.newContext({
    baseURL: uiBaseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await addVirtualAuthenticator(page);
  await page.goto("/login");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.locator("#register-name").fill(name);
  await page.locator("#register-email").fill(email);
  await page.locator("#register-invite").fill(inviteCode);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(async () => {
    const res = await page.request.get("/api/auth/get-session");
    // SAFETY: better-auth answers the session object or null; only the email is read.
    const session = (await res.json()) as { user?: { email?: string } };
    expect(session.user?.email).toBe(email);
  }).toPass({ timeout: 30_000 });
  await page.goto("/apps");
  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-finish").click();
  await page.reload();
  await expect(page.getByRole("dialog")).toBeHidden();
  return { context, page };
};

/** Create an app through the UI and mint an API key for pushing to it,
 * under the registered session. */
export const createAppWithKey = async (
  page: Page,
  request: APIRequestContext,
  app: { name: string; slug: string }
): Promise<{ apiKey: string; appId: string }> => {
  await page.goto("/apps/new");
  await page.locator("#create-name").fill(app.name);
  await page.locator("#create-slug").fill(app.slug);
  await page.getByRole("button", { name: "Create app" }).click();
  await page.waitForURL("**/apps", { timeout: 30_000 });
  const appId = await findAppId(request, app.slug);
  if (appId === null) {
    throw new Error(`app ${app.slug} was not created`);
  }
  const apiKey = await mintApiKey(page, `${app.slug}-ci`);
  return { apiKey, appId };
};

/** Push a sample directory as a fresh one-commit repo to `slug` via stock
 * git CLI. Copies to a temp dir so the checkout's nested sample repo stays
 * clean; the sample's own .gitignore keeps node_modules and build output out. */
export const pushAppDir = (
  apiKey: string,
  source: URL,
  slug: string
): string => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), `noite-${slug}-`));
  try {
    cpSync(source, dir, { recursive: true });
    // The sample checkout is itself a repo — drop its history so the push
    // is a fresh repo + fresh commit (new deploy), like deploy.sh re-init.
    rmSync(nodePath.join(dir, ".git"), { force: true, recursive: true });
    const git = (args: string[], extraEnv: Record<string, string> = {}) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, ...extraEnv },
      });
    git(["init", "-b", "main"]);
    git([
      "remote",
      "add",
      "origin",
      `http://git:${apiKey}@${gitBase.replace(/^https?:\/\//u, "")}/${slug}`,
    ]);
    git(["add", "-A"]);
    git(["commit", "-m", `${slug} deploy`], {
      GIT_AUTHOR_EMAIL: E2E_EMAIL,
      GIT_AUTHOR_NAME: E2E_NAME,
      GIT_COMMITTER_EMAIL: E2E_EMAIL,
      GIT_COMMITTER_NAME: E2E_NAME,
    });
    git(["push", "-uf", "origin", "main"]);
    return git(["rev-parse", "HEAD"]).trim();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/** Push the sample app (apps/noite/test) to the e2e slug. */
export const pushSampleApp = (apiKey: string): string =>
  pushAppDir(apiKey, new URL("../test", import.meta.url), E2E_SLUG);

/** Read-only probe of the deployed sample (counter `?read=1` never advances). */
export const readSampleApp = async (
  request: APIRequestContext,
  port: number
): Promise<{ n: number }> => {
  const res = await request.get(`${tenantBase(port)}/?read=1`);
  if (!res.ok) {
    throw new Error(`tenant ${res.status()} ${await res.text()}`);
  }
  // SAFETY: the sample counter answers { n } on ?read=1 (test/index.js probe).
  return (await res.json()) as { n: number };
};
