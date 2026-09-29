import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  appListenPort,
  findAppId,
  runnerApi,
  waitForDeploy,
} from "./helpers";

const HOSTILE_SLUG = "hostile";
const gitBase = process.env.E2E_GIT_BASE ?? "http://localhost:8080/v1/git";

interface Probe {
  ok: boolean;
  detail: string;
  mustSucceed?: boolean;
}

interface ProbeReport {
  build: { probes: Record<string, Probe> };
  release: { probes: Record<string, Probe> };
  worker: Record<string, Probe>;
  secrets: Record<string, string>;
}

const pushHostileApp = (apiKey: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "noite-hostile-"));
  try {
    cpSync(new URL("../test/hostile", import.meta.url), dir, {
      recursive: true,
    });
    rmSync(path.join(dir, ".git"), { force: true, recursive: true });
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
      `http://git:${apiKey}@${gitBase.replace(/^https?:\/\//u, "")}/${HOSTILE_SLUG}`,
    ]);
    git(["add", "-A"]);
    git(["commit", "-m", "hostile deploy"], {
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

// Hostile tenant (SPEC, Hostile-tenant suite): the Worker and build scripts
// attempt each attack and report results as JSON; every attempt must fail
// except internet egress. It only means something against an install that
// claims isolation: the single image with NOITE_TENANCY=multi and its
// capabilities (NET_ADMIN, SETUID, SETGID, CHOWN). The 4-service lane runs
// single tenancy and would fail it by design, so the lane opts in with
// E2E_HOSTILE=1.
test("hostile tenant is contained", async ({ page, request }) => {
  test.skip(
    process.env.E2E_HOSTILE !== "1",
    "needs the isolation lane (E2E_HOSTILE=1, single image, NOITE_TENANCY=multi)"
  );
  await page.goto("/apps/new");
  await page.locator("#create-name").fill("Hostile");
  await page.locator("#create-slug").fill(HOSTILE_SLUG);
  await page.getByRole("button", { name: "Create app" }).click();
  await page.waitForURL("**/apps", { timeout: 30_000 });

  const appId = await findAppId(request, HOSTILE_SLUG);
  expect(appId).not.toBeNull();
  await page.goto("/account");
  await page
    .locator('button[type="button"]', { hasText: "Create key" })
    .click();
  await page.locator("#key-name").fill("hostile-ci");
  await page
    .locator('button[type="submit"]', { hasText: "Create key" })
    .click();
  const rawKey = await page.locator("code.break-all").first().textContent();
  const apiKey = rawKey?.trim() ?? "";
  expect(apiKey.length).toBeGreaterThan(0);

  pushHostileApp(apiKey);
  const deploy = await waitForDeploy(request, appId ?? "");
  expect(deploy.status).toBe("success");

  const port = await appListenPort(request, appId ?? "");
  // A real neighbour: another deployed app (the deploy spec's). Its internal
  // (operator) port is the probe target; its public port is how the lane
  // checks it still serves afterwards. Without one the probe would aim at a
  // port nothing listens on and pass without proving anything.
  const apps = await runnerApi<
    { internalPort: number | null; listenPort: number | null; slug: string }[]
  >(request, "/v1/apps");
  const other = apps.find(
    (a) =>
      a.slug !== HOSTILE_SLUG &&
      a.internalPort !== null &&
      a.listenPort !== null
  );
  expect(other, "needs a second deployed app as the neighbour").toBeDefined();
  const neighbour = other?.internalPort ?? 0;
  const neighbourPublic = other?.listenPort ?? 0;
  const res = await request.get(
    `http://localhost:${port}/probes?neighbour=${neighbour}`
  );
  expect(res.ok()).toBe(true);
  // SAFETY: the hostile worker answers /probes with { build, release, worker, secrets } (test/hostile/index.js).
  const report = (await res.json()) as ProbeReport;

  for (const [name, probe] of Object.entries(report.build.probes)) {
    expect(probe.ok, `build probe ${name} leaked: ${probe.detail}`).toBe(false);
  }
  for (const [name, probe] of Object.entries(report.release.probes)) {
    if (name === "scoped-prefix") {
      continue;
    }
    expect(probe.ok, `release probe ${name} leaked: ${probe.detail}`).toBe(
      false
    );
  }
  for (const [name, probe] of Object.entries(report.worker)) {
    if (probe.mustSucceed === true) {
      expect(probe.ok, `worker egress ${name} must succeed`).toBe(true);
    } else {
      expect(probe.ok, `worker probe ${name} leaked: ${probe.detail}`).toBe(
        false
      );
    }
  }
  for (const [key, value] of Object.entries(report.secrets)) {
    expect(value, `worker env ${key} leaked`).toBe("absent");
  }

  // Neighbour still serves after the probes.
  const neighbourRes = await request.get(
    `http://localhost:${neighbourPublic}/`
  );
  expect([200, 404]).toContain(neighbourRes.status());
});
