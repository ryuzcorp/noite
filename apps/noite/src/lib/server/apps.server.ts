import { Data } from "effect";
import * as Schema from "effect/Schema";

import type { AppDetail, SlugCheck } from "../api-types";
import { deployStatusFacts, parseDesiredState } from "../app-detail/lifecycle";
import type { CreateSourceInput } from "../apps/create-source";
import { TEMPLATES } from "../apps/templates";
import { failUnknown, UnauthorizedError } from "../auth";
import {
  dropAppCollaborators,
  grantCollaborator,
  requireAppRole,
} from "../collaborators";
import {
  CREATE_TIMEOUT_MS,
  isSlugTaken,
  runnerCreateApp,
  runnerGetAppBySlug,
  runnerDeleteApp,
  runnerCancelDeploy,
  runnerDeployLog,
  runnerGitRemote,
  runnerListApps,
  runnerListDeploys,
  runnerPatchApp,
  runnerRenameApp,
  runnerRetryImport,
  runnerFailureMessage,
  runnerFailureOf,
  runnerRollback,
} from "../runner";
import type {
  RunnerFailure,
  RunnerApp,
  RunnerCreateSource,
  RunnerDeploy,
} from "../runner";
import { apiAction, fail } from "./api";
import { requireTelemetryRole } from "./errors.server";
import { requireViewApp, sessionUser } from "./session.server";

/** A runner failure as the action's 422 text: the runner's own RPC text
 * (e.g. the app limit) or a status line, never an upstream HTTP body. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site mapper: the thrown value is unknown by construction and becomes the safe runner text here.
const failRunner = (error: unknown): never =>
  failUnknown(runnerFailureMessage(runnerFailureOf(error)));

/** A lifecycle mutation's outcome, as the action answers it. One closed
 * type: `Purging` is a real state (the row is gone from every list, storage
 * still deletes in the background), never a plain success. */
export type MutationOutcome = Data.TaggedEnum<{
  Applied: Record<never, never>;
  Purging: Record<never, never>;
}>;

const Mutation = Data.taggedEnum<MutationOutcome>();

/** The wire value for an outcome. `Applied` stays exactly `{ok:true}` (the
 * shape every action has always answered); `Purging` adds `deleting`. */
const outcomeValue = (
  outcome: MutationOutcome
): { deleting?: true; ok: true } =>
  outcome._tag === "Purging" ? { deleting: true, ok: true } : { ok: true };

const CreateSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("blank") }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    path: Schema.optional(Schema.String),
    ref: Schema.optional(Schema.String),
    url: Schema.String,
  }),
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("template") }),
]);

const CreateApp = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
  source: Schema.optional(CreateSource),
});

const AppId = Schema.String;
const SLUG_RE = /^[a-z0-9](?<slug>[a-z0-9-]{0,46}[a-z0-9])?$/u;

/** Slugs the platform owns (the runner's own `RESERVED_SLUGS`, `lifecycle.rs`). */
const RESERVED_SLUGS = {
  _control: true,
  api: true,
  app: true,
  git: true,
} satisfies Record<string, true>;

/** Why a slug cannot be used, or null when it can — the one gate create,
 * rename and the push-to-create path (A5) all apply. */
export const slugError = (slug: string): string | null => {
  if (Object.hasOwn(RESERVED_SLUGS, slug)) {
    return "Slug is reserved";
  }

  if (!SLUG_RE.test(slug)) {
    return "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit";
  }

  return null;
};

/** How many numbered variants (`slug-2` … ) a taken slug's suggestion tries. */
const SUGGESTION_TRIES = 50;

/** The first free `<slug>-<n>` (n ≥ 2) that is still a valid slug, or null. */
const freeVariant = (
  slug: string,
  taken: ReadonlySet<string>
): string | null => {
  for (let n = 2; n < SUGGESTION_TRIES + 2; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, 48 - suffix.length).replace(/-+$/u, "")}${suffix}`;

    if (!(taken.has(candidate) || slugError(candidate))) {
      return candidate;
    }
  }

  return null;
};

/** Check a slug before create: shape, reserved names, and whether an app
 * already holds it (slugs are instance-wide: one hostname per slug), plus the
 * addresses it would get. A slug's existence is already public — it is a
 * hostname — so answering "taken" leaks nothing a request to it would not. */
export const slugCheck = apiAction(
  Schema.Struct({ slug: Schema.String }),
  async ({ slug }, { env, request }) => {
    await sessionUser(request, env);
    const normalized = slug.trim().toLowerCase();
    const gitBase = (env?.GIT_PUBLIC_BASE ?? "").replace(/\/+$/u, "");

    const result: SlugCheck = {
      error: slugError(normalized),
      gitRemote: gitBase === "" ? "" : `${gitBase}/${normalized}`,
      host: `${normalized}.${env?.BASE_DOMAIN ?? "localhost"}`,
      suggestion: null,
    };

    if (result.error) {
      return result;
    }

    try {
      const apps = await runnerListApps();
      const taken = new Set(apps.map((app) => app.slug));

      if (taken.has(normalized)) {
        result.error = `${normalized} is already taken`;
        result.suggestion = freeVariant(normalized, taken);
      }
    } catch (error) {
      failRunner(error);
    }

    return result;
  }
);

/** The account a create runs for — the session user, or the API-key owner on
 * the push-to-create path (/internal/git-auth). */
export interface CreateAccount {
  id: string;
  name: string;
}

/** Resolve what the runner should import. A template is named by id and
 * resolved here against the shipped list, so a client can never point an
 * import at another URL; the `actor` (who a squashed commit is authored as) is
 * filled from the account, never from the request. */
const toRunnerSource = (
  source: CreateSourceInput | undefined,
  account: CreateAccount
): RunnerCreateSource => {
  if (!source || source.kind === "blank") {
    return { kind: "blank" };
  }

  const actor = { name: account.name, userId: account.id };

  if (source.kind === "template") {
    // `?? fail()` (not an `if` guard): this toolchain does not narrow on
    // never-returning calls, but does narrow a `never`-typed `??` branch.
    const picked =
      TEMPLATES.find((template) => template.id === source.id) ??
      fail(`Unknown template: ${source.id}`);

    return {
      actor,
      kind: "git",
      path: picked.path,
      ref: picked.ref,
      squash: true,
      url: picked.url,
    };
  }

  return {
    actor,
    kind: "git",
    path: source.path,
    ref: source.ref,
    url: source.url,
  };
};

/** The adopt poll after a create's own bound: 4 s, so create (8 s) plus the
 * recovery (4 s) plus the grant and the response fit inside the route's 15 s
 * bound. Past that the route answers a 504 for an app that is still being
 * granted, which is the bug this budget removes. */
const CREATE_ADOPT_MS = 4000;

/** One create's recovery deadline (create RPC + adopt poll), measured from
 * before the create RPC. Exported so a test pins it under the route bound:
 * this whole path used to run up to ~24 s inside a 15 s route. */
export const CREATE_RECOVERY_MS = CREATE_TIMEOUT_MS + CREATE_ADOPT_MS;

/** Adopt the row of a create that outlived the control plane's bound: the
 * runner runs create detached, so the app lands after the RPC was aborted
 * and the grant below never ran — an app with no grant is invisible to every
 * list. Polls by slug until `deadline` (the whole create's recovery budget),
 * each lookup bounded by the time left. `null` when it never appeared or was
 * created for someone else. */
const adoptSlowCreate = async (
  slug: string,
  userId: string,
  deadline: number
): Promise<RunnerApp | null> => {
  for (;;) {
    const left = deadline - Date.now();

    if (left <= 0) {
      return null;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- polling: each attempt must observe the row the last one missed
    const existing = await runnerGetAppBySlug(slug, left).catch(() => null);

    if (existing) {
      return existing.userId === userId ? existing : null;
    }

    const wait = Math.min(500, deadline - Date.now());

    if (wait <= 0) {
      return null;
    }

    const { promise, resolve } = Promise.withResolvers<null>();
    setTimeout(() => {
      resolve(null);
    }, wait);
    // oxlint-disable-next-line eslint/no-await-in-loop -- the next poll waits this interval
    await promise;
  }
};

/** Create an app for one account and grant that account admin — the single
 * implementation behind the create action and /internal/git-auth's
 * push-to-create (A5). The runner owns the app row; the grant is ours, and a
 * failed grant rolls the row back so no app is left unopenable. */
export const createAppForUser = async (input: {
  account: CreateAccount;
  name: string;
  slug: string;
  source?: CreateSourceInput;
}): Promise<RunnerApp> => {
  let app: RunnerApp;
  const deadline = Date.now() + CREATE_RECOVERY_MS;

  try {
    app = await runnerCreateApp({
      name: input.name,
      slug: input.slug,
      source: toRunnerSource(input.source, input.account),
      userId: input.account.id,
    });
  } catch (error) {
    // One classifier for every runner failure (never `error.name` or English
    // text at the call site).
    const failure: RunnerFailure = runnerFailureOf(error);

    // A create that outlived the control plane's bound still runs in the
    // runner (it is detached), so a retry can find the slug taken by the
    // caller's own first attempt. Treat that as the same create instead of
    // failing the retry, and grant the account below as usual.
    if (isSlugTaken(failure)) {
      const existing = await runnerGetAppBySlug(input.slug).catch(() => null);

      if (existing?.userId !== input.account.id) {
        throw error;
      }

      app = existing;
    } else if (failure.kind === "timeout") {
      // The same detached create, but the caller saw the abort: adopt the
      // row when it lands (inside the create's recovery budget) instead of
      // leaving the app un-granted.
      const existing = await adoptSlowCreate(
        input.slug,
        input.account.id,
        deadline
      );

      if (!existing) {
        // The runner runs create detached: a row can still land after the
        // recovery budget, un-granted and therefore invisible in every list.
        // Nothing in-band can fix that; leave an operator signal.
        console.error(
          "[apps] detached create may have landed un-granted for slug",
          input.slug
        );
        throw error;
      }

      app = existing;
    } else {
      throw error;
    }
  }

  try {
    await grantCollaborator(app.id, input.account.id, "admin");
  } catch (grantError) {
    // Rollback is best-effort, but a failed rollback is its own state: an app
    // exists with no collaborator grant, so say so instead of swallowing it.
    const rolledBack = await runnerDeleteApp(app.id).then(
      () => true,
      () => false
    );

    if (!rolledBack) {
      console.error(
        "[apps] grant failed and the rollback failed: app",
        app.id,
        "has no collaborator grant"
      );
    }

    failUnknown(grantError);
  }

  return app;
};

export const create = apiAction(
  CreateApp,
  async ({ name, slug, source }, { env, request }) => {
    const user = await sessionUser(request, env);
    const trimmedName = name.trim();
    const normalized = slug.trim().toLowerCase();

    if (!trimmedName) {
      fail("Name is required");
    }

    const slugProblem = slugError(normalized);

    if (slugProblem) {
      fail(slugProblem);
    }

    try {
      const app = await createAppForUser({
        account: { id: user.id, name: user.name },
        name: trimmedName,
        slug: normalized,
        source,
      });

      return { id: app.id };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      return failRunner(error);
    }
  }
);

/** Retry a failed GitHub/template import (A2) with the source stored on the
 * app row: the app page offers this whenever the import ended in `error`. */
export const retryImport = apiAction(AppId, async (appId, { env, request }) => {
  const user = await sessionUser(request, env);
  await requireAppRole(appId, user.id, "push");

  try {
    return await runnerRetryImport(appId);
  } catch (error) {
    failRunner(error);
  }
});

export const remove = apiAction(AppId, async (appId, { env, request }) => {
  const user = await sessionUser(request, env);
  await requireAppRole(appId, user.id, "admin");

  try {
    const result = await runnerDeleteApp(appId);

    // The runner accepted the delete: a cleanup failure is logged, never
    // reported as a failed delete (the app is gone either way). Nothing
    // cascades grants now that the app row lives in the runner.
    const cleaned = await dropAppCollaborators(appId).then(
      () => true,
      () => false
    );

    if (!cleaned) {
      console.error(
        "[apps] app deleted but collaborator cleanup failed for",
        appId
      );
    }

    return outcomeValue(
      result.deleting ? Mutation.Purging() : Mutation.Applied()
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    failRunner(error);
  }
});

export const setDesired = apiAction(
  Schema.Struct({ desiredState: Schema.String, id: Schema.String }),
  async ({ id, desiredState: raw }, { env, request }) => {
    // `?? fail()` (not an `if` guard): this toolchain does not narrow on
    // never-returning calls, but does narrow a `never`-typed `??` branch.
    const next =
      parseDesiredState(raw) ?? fail("desiredState must be running or stopped");

    const user = await sessionUser(request, env);
    await requireAppRole(id, user.id, "push");

    try {
      await runnerPatchApp(id, { desiredState: next });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      failRunner(error);
    }
  }
);

const RenameApp = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

/** Rename an app (display name and/or slug). Admin-gated; a slug change
 * moves the subdomain, git remote, and fleet data via the runner op. */
export const renameApp = apiAction(
  RenameApp,
  async ({ id, name, slug }, { env, request }) => {
    const trimmedName = name?.trim() || undefined;
    const normalized = slug?.trim().toLowerCase() || undefined;

    if (!trimmedName && !normalized) {
      fail("Name or slug required");
    }

    const slugProblem = normalized ? slugError(normalized) : null;

    if (slugProblem) {
      fail(slugProblem);
    }

    const user = await sessionUser(request, env);
    await requireAppRole(id, user.id, "admin");

    try {
      await runnerRenameApp(id, { name: trimmedName, slug: normalized });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      failRunner(error);
    }
  }
);

export const get = apiAction(
  AppId,
  async (appId, { env, request }): Promise<AppDetail> => {
    const user = await sessionUser(request, env);
    const { app, role } = await requireAppRole(appId, user.id, "view");
    const git = await runnerGitRemote(appId);

    return {
      app,
      gitHint: `git remote add origin ${git.url}`,
      gitRemote: git.url,
      host: git.url.replace(/^https?:\/\//u, ""),
      myRole: role,
      s3Endpoint: git.endpoint,
      username: git.username,
    };
  }
);

const RollbackArgs = Schema.Struct({
  appId: Schema.String,
  /** One preview environment's history; absent/"" is production. */
  environmentId: Schema.optional(Schema.String),
  sha: Schema.String,
});

/** Rollback to a previous successful deploy sha (push-gated): re-runs
 * the pipeline at the old tip bundle. Progress follows on the deploys
 * stream like a normal deploy. */
export const rollback = apiAction(
  RollbackArgs,
  async ({ appId, sha, environmentId }, { env, request }) => {
    const user = await sessionUser(request, env);
    const { role } = await requireAppRole(appId, user.id, "push");

    try {
      return await runnerRollback(appId, sha, environmentId ?? "", role);
    } catch (error) {
      failRunner(error);
    }
  }
);

const CancelDeployArgs = Schema.Struct({
  appId: Schema.String,
  deployId: Schema.String,
});

/** Stop an in-flight deploy (push-gated): the runner kills the step's process
 * group and closes the row with "cancelled by the operator". 409 when the
 * deploy already finished. */
export const cancelDeploy = apiAction(
  CancelDeployArgs,
  async ({ appId, deployId }, { env, request }) => {
    const user = await sessionUser(request, env);
    await requireAppRole(appId, user.id, "push");

    try {
      return await runnerCancelDeploy(appId, deployId);
    } catch (error) {
      failRunner(error);
    }
  }
);

const DeployLogArgs = Schema.Struct({
  appId: Schema.String,
  deployId: Schema.String,
});

/** One finished deploy's build log (view-gated): the stream omits finished
 * rows' logs, so the panel fetches them on demand per deploy id. */
export const deployLog = apiAction(
  DeployLogArgs,
  async ({ appId, deployId }, { env, request }) => {
    await requireViewApp(request, env, appId);

    try {
      return await runnerDeployLog(appId, deployId);
    } catch (error) {
      failRunner(error);
    }
  }
);

const ListDeploysArgs = Schema.Struct({
  appId: Schema.String,
  environmentId: Schema.optional(Schema.String),
});

/** Lean rows like the deploys stream (newest first): finished rows carry no
 * build log (fetch it from `deployLog` on demand) — only the newest row
 * keeps its live log while in flight. "In flight" is the shared deploy facts,
 * so a cancelled or stalled row is finished like any other. Exported for the
 * unit tests. */
export const leanDeployRows = (rows: RunnerDeploy[]): RunnerDeploy[] =>
  rows.map((deploy, index) =>
    index === 0 && deployStatusFacts(deploy.status).inFlight
      ? deploy
      : { ...deploy, log: "" }
  );

/** Deploy history, optionally in one preview environment (absent/"" is
 * production): the initial snapshot behind the live Deployments list, so it
 * renders current data even when the stream's first frame is delayed or
 * lost. View-gated like the stream. */
export const listDeploys = apiAction(
  ListDeploysArgs,
  async ({ appId, environmentId }, { env, request }) => {
    await requireTelemetryRole(request, env, appId, "view");

    try {
      const rows = await runnerListDeploys(appId, environmentId ?? "");

      return leanDeployRows(rows);
    } catch (error) {
      failRunner(error);
    }
  }
);
