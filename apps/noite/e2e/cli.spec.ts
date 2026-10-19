import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  createAppWithKey,
  deleteApp,
  waitForDeploy,
} from "./helpers";

// The published artifact (`@noitenow/cli`), built from the tree and driven
// through the lane's edge exactly like production: git over
// `git.<base>` (Caddy rewrites it to the runner's smart-HTTP), the app
// served on `<slug>.<base>`. The bundle runs under plain node — never bun —
// so this is also the smoke test for the runtime the package declares.
const DEPLOY_SLUG = "cli";
const ENVS_SLUG = "cli-envs";

const cliDir = fileURLToPath(new URL("../../../packages/cli", import.meta.url));
const cliBin = nodePath.join(cliDir, "dist", "bin.js");

const control = new URL(
  process.env.E2E_BASE_URL ?? "http://noite.localhost:8090"
);

const gitOrigin = `${control.protocol}//git.${control.host}`;
const deployOrigin = `${control.protocol}//${DEPLOY_SLUG}.${control.host}`;

/** A prebuilt app: a worker plus its wrangler config, no package.json, so
 * the runner skips its source build and deploys the tree as-is. Flat on
 * purpose: `deploy` stages `--dist` contents plus `--wrangler` at the root,
 * and a branch push of the same dir carries exactly that shape. */
const seedPrebuiltApp = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  await writeFile(
    nodePath.join(root, "worker.js"),
    'export default {\n  async fetch() {\n    return new Response("hello from cli");\n  },\n};\n'
  );
  await writeFile(
    nodePath.join(root, "wrangler.jsonc"),
    JSON.stringify(
      {
        compatibility_date: "2026-01-01",
        main: "./worker.js",
        name: "cli",
      },
      null,
      2
    )
  );
};

/** Run the built CLI under plain node, resolving combined output. Rejects
 * (with the combined output) when the command exits non-zero. */
const runCli = (args: readonly string[]): string => {
  const proc = spawnSync("node", [cliBin, ...args], {
    encoding: "utf-8",
    env: { ...process.env },
  });

  if (proc.error) {
    throw proc.error;
  }

  const output = `${proc.stdout}${proc.stderr}`;

  if (proc.status !== 0) {
    throw new Error(`noite ${args.join(" ")} failed:\n${output}`);
  }

  return output;
};

/** The connection flags every CLI call below carries. */
const connFlags = (slug: string, apiKey: string): readonly string[] => [
  "--slug",
  slug,
  "--url",
  gitOrigin,
  "--token",
  apiKey,
];

/** Push the seeded prebuilt tree as `ref` of `slug` with stock git. */
const pushSeededBranch = (
  dir: string,
  apiKey: string,
  slug: string,
  ref: string
): void => {
  const git = (args: readonly string[]) =>
    execFileSync("git", [...args], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: E2E_EMAIL,
        GIT_AUTHOR_NAME: E2E_NAME,
        GIT_COMMITTER_EMAIL: E2E_EMAIL,
        GIT_COMMITTER_NAME: E2E_NAME,
      },
    });

  git(["init", "-b", "main"]);
  git([
    "remote",
    "add",
    "origin",
    `http://git:${apiKey}@${gitOrigin.replace(/^https?:\/\//u, "")}/${slug}`,
  ]);
  git(["add", "-A"]);
  git(["commit", "-m", `${slug} ${ref}`]);
  git(["push", "-uf", "origin", `main:${ref}`]);
};

/** Every app this spec creates, dropped after the file. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each purges a fleet on the runner
    await deleteApp(request, slug);
  }
});

test.beforeAll(() => {
  const proc = spawnSync("bun", ["run", "build"], {
    cwd: cliDir,
    encoding: "utf-8",
  });

  if (proc.error) {
    throw proc.error;
  }

  expect(proc.status).toBe(0);
});

test("noite deploy ships a prebuilt dist and the printed URL serves it", async ({
  page,
  request,
}) => {
  createdApps.push(DEPLOY_SLUG);

  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "CLI",
    slug: DEPLOY_SLUG,
  });

  const dir = mkdtempSync(nodePath.join(tmpdir(), "noite-cli-"));

  try {
    await seedPrebuiltApp(dir);

    const output = runCli([
      "deploy",
      ...connFlags(DEPLOY_SLUG, apiKey),
      "--dist",
      dir,
      "--wrangler",
      nodePath.join(dir, "wrangler.jsonc"),
    ]);

    const printed = output.match(/→ (?<url>\S+)\s*$/mu)?.groups?.url ?? "";
    expect(printed).toBe(deployOrigin);

    const deploy = await waitForDeploy(request, appId);
    expect(deploy.status, deploy.log).toBe("success");

    // A first deploy spawns the fleet; the edge answers 503 until celld
    // listens, so poll the printed URL itself (not the raw port — the
    // point is the address the CLI hands out).
    await expect
      .poll(
        async (): Promise<string> => {
          await page.goto(printed);

          return (await page.getByText("hello from cli").count()) === 0
            ? ""
            : "hello from cli";
        },
        { timeout: 180_000 }
      )
      .toBe("hello from cli");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("noite environments manages vars over the control origin", async ({
  page,
  request,
}) => {
  createdApps.push(ENVS_SLUG);

  const { apiKey } = await createAppWithKey(page, request, {
    name: "CLI envs",
    slug: ENVS_SLUG,
  });

  // The environment needs a real branch that is not main: push the same
  // prebuilt tree the deploy test ships, so the environment's own deploy
  // (which `create` starts) has something real to build.
  const dir = mkdtempSync(nodePath.join(tmpdir(), "noite-cli-env-"));

  try {
    await seedPrebuiltApp(dir);
    pushSeededBranch(dir, apiKey, ENVS_SLUG, "refs/heads/staging");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }

  // `--app-url` is absent throughout: the control origin derives from the
  // git base (`git.<base>` → `<base>` on a localhost install).
  const env = (sub: readonly string[]): string =>
    runCli(["environments", ...sub, ...connFlags(ENVS_SLUG, apiKey)]);

  env(["create", "--branch", "staging"]);
  expect(env(["list"])).toContain("staging");

  env(["vars", "set", "staging", "CLI_E2E", "hello"]);
  expect(env(["vars", "get", "staging"])).toContain("CLI_E2E");

  env(["vars", "unset", "staging", "CLI_E2E"]);
  expect(env(["vars", "get", "staging"])).not.toContain("CLI_E2E");

  env(["delete", "staging"]);
});
