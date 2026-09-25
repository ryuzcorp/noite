import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { sleep } from "$lib/sleep";
import type { APIRequestContext, Page } from "@playwright/test";

export const E2E_EMAIL = "e2e@noite.local";
export const E2E_NAME = "E2E";
export const E2E_SLUG = "e2e";

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
  // 204 and error bodies are not JSON; callers only read status then.
  const body = await res.json().catch(() => null);
  return { body, status: res.status() };
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
    await sleep(10_000);
  }
};

/** Push the sample app (apps/noite/test) to the slug via stock git CLI.
 * Copies to a temp dir so the checkout's nested sample repo stays clean. */
export const pushSampleApp = (apiKey: string): string => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "noite-e2e-"));
  try {
    cpSync(new URL("../test", import.meta.url), dir, { recursive: true });
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
      `http://git:${apiKey}@${gitBase.replace(/^https?:\/\//u, "")}/${E2E_SLUG}`,
    ]);
    git(["add", "-A"]);
    git(["commit", "-m", "e2e deploy"], {
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
