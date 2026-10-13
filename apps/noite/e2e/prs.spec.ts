import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext } from "@playwright/test";

import {
  E2E_EMAIL,
  E2E_NAME,
  createAppWithKey,
  deleteApp,
  mintApiKey,
  pushAppDir,
  readInviteCode,
  registerInviteeAccount,
  runnerApi,
  runnerCall,
  waitForDeploy,
} from "./helpers";

// F4: pull requests and branch protection. The PR data is exercised on the
// runner's REST mirror (the same raw-port lane the hardening/lifecycle specs
// use — the panels are a known-broken surface under celld), while the branch
// protection rule is set through the settings panel it belongs to and the
// protected-`main` push is a real git push against the runner's git policy.

const gitBase = process.env.E2E_GIT_BASE ?? "http://localhost:8080/v1/git";

interface PrDetail {
  approvals: number;
  comments: {
    id: string;
    line: number | null;
    outdated: boolean;
    path: string | null;
  }[];
  mergeState: string;
  pullRequest: {
    commentCount: number;
    headSha: string;
    mergeSha: string | null;
    number: number;
    state: string;
  };
  reviews: { dismissedAt: string | null; id: string; state: string }[];
}

interface GitRefsBody {
  branches: { name: string; sha: string }[];
  defaultBranch: string;
}

interface GitLogBody {
  commits: { sha: string }[];
}

/** `runnerCall` widens its body to a union; each caller already knows the
 * shape its endpoint answers, so the cast is local to the read. */
const asJson = <T>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- runnerCall parses the body at the HTTP boundary; only its static type is unknown here.
  body: unknown
): T =>
  // SAFETY: the caller names the exact response type of the endpoint it hit (the REST mirror of the matching RPC).
  body as T;

const actorOf = (userId: string) => ({ name: userId, userId });

const openPr = async (
  request: APIRequestContext,
  appId: string,
  pr: { authorId: string; base: string; head: string; title: string }
): Promise<PrDetail> => {
  const res = await runnerCall(request, `/v1/apps/${appId}/pull_requests`, {
    body: {
      actor: actorOf(pr.authorId),
      base: pr.base,
      head: pr.head,
      title: pr.title,
    },
    method: "POST",
  });
  expect(res.status).toBe(200);
  return asJson<PrDetail>(res.body);
};

const fetchPr = async (
  request: APIRequestContext,
  appId: string,
  number: number
): Promise<PrDetail> => {
  const res = await runnerCall(
    request,
    `/v1/apps/${appId}/pull_requests/${number}`
  );
  expect(res.status).toBe(200);
  return asJson<PrDetail>(res.body);
};

const reviewPr = (
  request: APIRequestContext,
  appId: string,
  number: number,
  reviewerId: string
) =>
  runnerCall(request, `/v1/apps/${appId}/pull_requests/${number}/reviews`, {
    body: {
      actor: actorOf(reviewerId),
      role: "push",
      state: "approved",
    },
    method: "POST",
  });

const mergePr = (
  request: APIRequestContext,
  appId: string,
  number: number,
  actorId: string,
  role: string
) =>
  runnerCall(request, `/v1/apps/${appId}/pull_requests/${number}/merge`, {
    body: {
      actor: actorOf(actorId),
      deleteBranch: true,
      role,
      title: "PRs: squash merge",
    },
    method: "POST",
  });

const commentOnLine = (
  request: APIRequestContext,
  appId: string,
  number: number,
  anchor: { commitSha: string; line: number; path: string; side: string }
) =>
  runnerCall(request, `/v1/apps/${appId}/pull_requests/${number}/comments`, {
    body: {
      actor: actorOf("pr-reviewer"),
      body: "Please rework this line.",
      commitSha: anchor.commitSha,
      line: anchor.line,
      path: anchor.path,
      role: "push",
      side: anchor.side,
    },
    method: "POST",
  });

/** Temp clones and second browser contexts are cleaned up after every test. */
const tempDirs: string[] = [];
const contexts: BrowserContext[] = [];

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

test.afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  const closing = contexts.splice(0);
  await Promise.all(closing.map((context) => context.close()));
});

/** A throwaway clone of `slug`, authenticated with `apiKey`. */
const cloneRepo = (apiKey: string, slug: string) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), `noite-prs-${slug}-`));
  tempDirs.push(dir);
  execFileSync(
    "git",
    [
      "clone",
      `http://git:${apiKey}@${gitBase.replace(/^https?:\/\//u, "")}/${slug}`,
      dir,
    ],
    { encoding: "utf-8" }
  );
  const run = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: E2E_EMAIL,
        GIT_AUTHOR_NAME: E2E_NAME,
        GIT_COMMITTER_EMAIL: E2E_EMAIL,
        GIT_COMMITTER_NAME: E2E_NAME,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  return { dir, run };
};

/** Write `files`, stage and commit on the checked-out branch; returns the sha. */
const commitFiles = (
  repo: { dir: string; run: (args: string[]) => string },
  files: Record<string, string>,
  message: string
): string => {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(nodePath.join(repo.dir, name), content);
  }
  repo.run(["add", "-A"]);
  repo.run(["commit", "-m", message]);
  return repo.run(["rev-parse", "HEAD"]).trim();
};

const branchNames = async (
  request: APIRequestContext,
  appId: string
): Promise<string[]> => {
  const refs = await runnerApi<GitRefsBody>(
    request,
    `/v1/apps/${appId}/git/refs`
  );
  return refs.branches.map((branch) => branch.name);
};

const mainLog = (request: APIRequestContext, appId: string) =>
  runnerApi<GitLogBody>(request, `/v1/apps/${appId}/git/log?limit=100`);

test("a pull request is commented, approved, rebased onto a new head and merged", async ({
  page,
  request,
}) => {
  const slug = "prs-lifecycle";
  createdApps.push(slug);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "PRs Lifecycle",
    slug,
  });
  pushAppDir(apiKey, new URL("../test", import.meta.url), slug);

  // Feature branch with one commit to review.
  const repo = cloneRepo(apiKey, slug);
  repo.run(["checkout", "-b", "feature"]);
  const featureSha = commitFiles(
    repo,
    {
      "FEATURE.md": "# Feature\n\nFirst line.\n",
    },
    "prs: feature commit"
  );
  repo.run(["push", "-u", "origin", "feature"]);

  // (1) Open the PR and leave a line comment on the new head.
  const opened = await openPr(request, appId, {
    authorId: "pr-author",
    base: "main",
    head: "feature",
    title: "Add a feature",
  });
  const { number } = opened.pullRequest;
  expect(opened.pullRequest.headSha).toBe(featureSha);
  // Anchored on the line the next commit rewrites, so the push strands it.
  const comment = await commentOnLine(request, appId, number, {
    commitSha: featureSha,
    line: 3,
    path: "FEATURE.md",
    side: "new",
  });
  expect(comment.status).toBe(200);
  const commented = await fetchPr(request, appId, number);
  expect(commented.pullRequest.commentCount).toBe(1);

  // (2) Approve, then push a new commit: the comment goes outdated and the
  // approval is dismissed because it was recorded at the old head.
  const approved = await reviewPr(request, appId, number, "pr-reviewer");
  expect(approved.status).toBe(200);
  expect(asJson<PrDetail>(approved.body).approvals).toBe(1);

  repo.run(["checkout", "feature"]);
  const newHead = commitFiles(
    repo,
    {
      "FEATURE.md": "# Feature\n\nRewritten first line.\n",
    },
    "prs: rework the first line"
  );
  repo.run(["push", "origin", "feature"]);
  expect(newHead).not.toBe(featureSha);

  const moved = await fetchPr(request, appId, number);
  expect(moved.pullRequest.headSha).toBe(newHead);
  expect(moved.comments[0]?.outdated).toBe(true);
  expect(moved.reviews[0]?.dismissedAt).not.toBeNull();
  expect(moved.approvals).toBe(0);

  // (3) A fresh approval on the new head unblocks the squash merge; the
  // branch is deleted and main gains exactly one commit that deploys.
  const reapproved = await reviewPr(request, appId, number, "pr-reviewer");
  expect(reapproved.status).toBe(200);
  const before = await mainLog(request, appId);

  const merged = await mergePr(request, appId, number, "pr-reviewer", "push");
  expect(merged.status).toBe(200);
  const mergedDetail = asJson<PrDetail>(merged.body);
  expect(mergedDetail.pullRequest.state).toBe("merged");
  const mergeSha = mergedDetail.pullRequest.mergeSha ?? "";
  expect(mergeSha).not.toBe("");

  const after = await mainLog(request, appId);
  expect(after.commits.length).toBe(before.commits.length + 1);
  expect(after.commits[0]?.sha).toBe(mergeSha);
  expect(await branchNames(request, appId)).not.toContain("feature");

  // The squash commit deploys like any other main push.
  await expect(async () => {
    const deploy = await waitForDeploy(request, appId);
    expect(deploy.sha).toBe(mergeSha);
  }).toPass({ timeout: 8 * 60_000 });
});

test("a conflicting pull request reports conflicts and refuses to merge", async ({
  page,
  request,
}) => {
  const slug = "prs-conflict";
  createdApps.push(slug);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "PRs Conflict",
    slug,
  });
  pushAppDir(apiKey, new URL("../test", import.meta.url), slug);

  // Both branches add the same file with different content → add/add conflict.
  const repo = cloneRepo(apiKey, slug);
  repo.run(["checkout", "-b", "clash"]);
  commitFiles(repo, { "conflict.txt": "clash version\n" }, "clash: add file");
  repo.run(["push", "-u", "origin", "clash"]);
  repo.run(["checkout", "main"]);
  commitFiles(repo, { "conflict.txt": "main version\n" }, "main: add file");
  repo.run(["push", "origin", "main"]);

  const detail = await openPr(request, appId, {
    authorId: "pr-author",
    base: "main",
    head: "clash",
    title: "Clashing change",
  });
  expect(detail.mergeState).toBe("conflicts");

  const refused = await mergePr(
    request,
    appId,
    detail.pullRequest.number,
    "pr-author",
    "admin"
  );
  expect(refused.status).toBe(409);

  // The PR is still open and its branch still there.
  const still = await fetchPr(request, appId, detail.pullRequest.number);
  expect(still.pullRequest.state).toBe("open");
  expect(await branchNames(request, appId)).toContain("clash");
});

test("an author cannot approve their own pull request", async ({
  page,
  request,
}) => {
  const slug = "prs-self-approve";
  createdApps.push(slug);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "PRs Self Approve",
    slug,
  });
  pushAppDir(apiKey, new URL("../test", import.meta.url), slug);

  const repo = cloneRepo(apiKey, slug);
  repo.run(["checkout", "-b", "feature"]);
  commitFiles(repo, { "FEATURE.md": "# Feature\n" }, "self: feature commit");
  repo.run(["push", "-u", "origin", "feature"]);

  const detail = await openPr(request, appId, {
    authorId: "pr-author",
    base: "main",
    head: "feature",
    title: "My own change",
  });
  const denied = await reviewPr(
    request,
    appId,
    detail.pullRequest.number,
    "pr-author"
  );
  expect(denied.status).toBe(400);

  const unchanged = await fetchPr(request, appId, detail.pullRequest.number);
  expect(unchanged.approvals).toBe(0);
  expect(unchanged.reviews).toHaveLength(0);
});

test("require_pr rejects a push-role push to main while an admin push lands", async ({
  browser,
  page,
  request,
}) => {
  const slug = "prs-protect";
  createdApps.push(slug);
  const { apiKey, appId } = await createAppWithKey(page, request, {
    name: "PRs Protect",
    slug,
  });
  pushAppDir(apiKey, new URL("../test", import.meta.url), slug);

  // The settings panel is where the rule lives: save it, then reload to prove
  // both fields round-tripped.
  await page.goto(`/apps/${appId}?panel=settings`);
  await page.locator("#branch-require-pr").check();
  await page.locator("#branch-approvals").selectOption("1");
  await page.getByRole("button", { name: "Save branch rules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.locator("#branch-require-pr")).toBeChecked();
  await expect(page.locator("#branch-approvals")).toHaveValue("1");

  // A second account joins as a push collaborator. It gets its invite code
  // from the e2e account's Account page, registers with it, then the e2e
  // admin invites the address and it accepts.
  const email = `push-user-${Date.now()}@example.com`;
  const inviteCode = await readInviteCode(page);

  const invitee = await registerInviteeAccount(
    browser,
    inviteCode,
    email,
    "Push User"
  );
  contexts.push(invitee.context);
  const pushKey = await mintApiKey(invitee.page, `${slug}-push`);

  await page.goto(`/apps/${appId}?panel=settings`);
  await page.getByRole("button", { exact: true, name: "Invite" }).click();
  await page.locator("#invite-email").fill(email);
  await page.locator("#invite-role").selectOption("push");
  await page
    .getByRole("dialog")
    .getByRole("button", { exact: true, name: "Invite" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await invitee.page.goto("/apps");
  await invitee.page
    .getByRole("button", { exact: true, name: "Accept" })
    .click();
  await expect(invitee.page).toHaveURL(new RegExp(`/apps/${appId}`, "u"));

  // The push role cannot commit to `main` while require_pr is on…
  const pushRepo = cloneRepo(pushKey, slug);
  commitFiles(
    pushRepo,
    { "PUSH-USER.md": "from the push collaborator\n" },
    "push user tries main"
  );
  expect(() => pushRepo.run(["push", "origin", "main"])).toThrow();

  // …but an admin's push goes straight through and deploys.
  const adminRepo = cloneRepo(apiKey, slug);
  const adminSha = commitFiles(
    adminRepo,
    { "ADMIN.md": "from the admin\n" },
    "admin pushes main"
  );
  adminRepo.run(["push", "origin", "main"]);
  await expect(async () => {
    const deploy = await waitForDeploy(request, appId);
    expect(deploy.sha).toBe(adminSha);
  }).toPass({ timeout: 8 * 60_000 });
});
