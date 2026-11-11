/* eslint-disable func-names -- Effect.gen uses anonymous generators */
/**
 * The MCP tool table (alpha.4 A4). Every tool runs as the account its API key
 * belongs to and passes the very same gates the UI's server actions do, so an
 * agent can do exactly what a collaborator of that role can: reads are `view`,
 * variables are `admin`, and creating an app goes through the one
 * `createAppForUser` path A5 uses. Tools call the wave 1 runner client
 * functions; nothing here duplicates another surface's logic.
 *
 * The second half of the table is the agent loop (code → pull request →
 * preview → merge → deploy → rollback) with no UI in it: `commit_files` and
 * the `*_branch`, `*_pr`, `rollback`/`redeploy`/`cancel_deploy` and
 * `wait_for_deploy` tools. They answer refusals an agent can act on
 * (`refusals.ts`) and every one resolves its app through `requireGatedApp`,
 * the same gate the read tools use.
 *
 * Each tool declares its arguments once, as an Effect schema: that is both the
 * parser the transport runs and the `inputSchema` it publishes, so an agent
 * never sees a contract the server does not enforce.
 */
import * as Schema from "effect/Schema";

import { appLifecycle } from "../app-detail/lifecycle";
import type { AppStatusPage } from "../app-detail/lifecycle";
import type { CreateSourceInput } from "../apps/create-source";
import { TEMPLATES } from "../apps/templates";
import { listAppsForCollaborator } from "../collaborators";
import { keyCoversApp } from "../key-principal";
import type { KeyPrincipal } from "../key-principal";
import type { AppRole } from "../roles";
import {
  runnerCancelDeploy,
  runnerDeleteEnv,
  runnerDeployLog,
  runnerEnvironmentCreate,
  runnerEnvironmentDelete,
  runnerEnvironmentDeploy,
  runnerEnvironmentUpdate,
  runnerEnvironmentVarDelete,
  runnerEnvironmentVarSet,
  runnerEnvironmentVars,
  runnerEnvironmentsList,
  runnerGitBranchCreate,
  runnerGitBranchDelete,
  runnerGitCommit,
  runnerGitLog,
  runnerGitRefs,
  runnerGitRemote,
  runnerListDeploys,
  runnerListEnv,
  runnerPrComment,
  runnerPrCreate,
  runnerPrGet,
  runnerPrMerge,
  runnerPrReview,
  runnerPrUpdate,
  runnerPrsList,
  runnerRollback,
  runnerRpc,
  runnerRpcBatch,
  runnerSetEnv,
  runnerSourceBlob,
  runnerSourceCommit,
  runnerSourceTree,
} from "../runner";
import type {
  GitCommitDetail,
  GitLog,
  GitRefs,
  PrDetail,
  PrSummary,
  RunnerApp,
  RunnerBlob,
  RunnerDeploy,
  RunnerEnvironment,
  RunnerErrorList,
  RunnerGitRemote,
  RunnerTree,
  SourceCommitBody,
} from "../runner";
import { createAppForUser, slugError } from "../server/apps.server";
import { redactEnv } from "../server/env.server";
import { keyAppVerdict } from "../server/key-access.server";
import { keyActor, userDisplayName } from "../server/key-attribution.server";
import { MAX_WAIT_SECONDS, realSleep, waitForDeploy } from "./deploy-wait";
import { prChecks } from "./pr-checks";
import type { PreviewFacts } from "./pr-checks";
import { defineTool, McpToolError } from "./protocol";
import type { McpToolDefinition } from "./protocol";
import { attempt, denyAs, refused } from "./refusals";

/** What each role lets a tool do, in the words of the error a denied caller
 * reads. */
const NEEDS: Record<AppRole, string> = {
  admin: "administer",
  push: "push to",
  view: "view",
};

/** The app one tool call names, by slug (how agents see apps) or by id (what
 * `create_app` and `list_apps` return). Both lookups go through the one
 * key-enforcement function, which resolves the owner's role per request and
 * applies the key's app set and role ceiling; a denial is one message for
 * "not found", "no access", "another key's app" and "above the ceiling" — the
 * same answer the UI gives, so an id is never an existence oracle. */
const requireApp = async (
  principal: KeyPrincipal,
  ref: string,
  need: AppRole
): Promise<{ app: RunnerApp; role: AppRole }> => {
  const bySlug = await keyAppVerdict(principal, { slug: ref }, need);

  if (bySlug._tag === "Granted") {
    return { app: bySlug.app, role: bySlug.role };
  }

  const byId = await keyAppVerdict(principal, { id: ref }, need);

  if (byId._tag === "Granted") {
    return { app: byId.app, role: byId.role };
  }

  throw new McpToolError(
    `No app "${ref}" this key can ${NEEDS[need]} (it may not exist, you may not be a collaborator, or the key may be limited to other apps).`
  );
};

const sha10 = (sha: string): string => sha.slice(0, 10);

const iso = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString();

/** The public URL of an app: edge scheme and port from the git remote the API
 * hands over, plus the app's own subdomain (same rule as the runner's
 * `public_app_url`). */
const appUrl = (remoteUrl: string, subdomain: string): string => {
  const parsed = new URL(remoteUrl);
  const port = parsed.port === "" ? "" : `:${parsed.port}`;

  return `${parsed.protocol}//${subdomain}${port}`;
};

/** An environment's public URL: `<label>.<slug>.<base>`, with the same scheme
 * and dev port as the app's own host (`app.subdomain` already carries
 * `slug.<base>`), one DNS label in front of it. */
const envUrl = (
  remoteUrl: string,
  subdomain: string,
  label: string
): string => {
  const parsed = new URL(remoteUrl);
  const port = parsed.port === "" ? "" : `:${parsed.port}`;

  return `${parsed.protocol}//${label}.${subdomain}${port}`;
};

/** Whether `deploy_status` should call an app or preview environment live:
 * it is serving, or it is asleep and the next request starts it. A crash- or
 * OOM-held fleet is not live — its row still reads `running`, but the
 * supervisor is in backoff until the hold's retry instant. */
export const deployStatusLive = (row: AppStatusPage): boolean =>
  appLifecycle(row)._tag === "Live";

/** Every environment of one app. `role` is the caller's role on that app,
 * resolved above; the runner refuses a missing one. */
const appEnvironments = (
  appId: string,
  role: AppRole
): Promise<RunnerEnvironment[]> => runnerEnvironmentsList(appId, role);

/** The environment one tool call names, by label or by id — one list covers
 * both lookups. A miss is the one message, like `requireApp`'s. */
const requireEnvironment = async (
  app: { id: string; slug: string },
  role: AppRole,
  ref: string
): Promise<RunnerEnvironment> => {
  const environments = await appEnvironments(app.id, role);
  const found = environments.find((env) => env.id === ref || env.label === ref);

  if (!found) {
    throw new McpToolError(
      `No environment "${ref}" in ${app.slug}. List them with list_environments (a label or an id).`
    );
  }

  return found;
};

/** One environment as every tool reports it: the fields a caller acts on plus
 * the URL it answers on (`<label>.<slug>.<base>`). The shape is inferred on
 * purpose: `structuredContent` is JSON, and a named interface has no implicit
 * index signature to satisfy it. */
const environmentRow = (
  env: RunnerEnvironment,
  subdomain: string,
  remoteUrl: string
) => ({
  asleepSince: env.asleepSince,
  desiredState: env.desiredState,
  gitRef: env.gitRef,
  id: env.id,
  kind: env.kind,
  label: env.label,
  lastDeploySha: env.lastDeploySha,
  lastDeployedAt: env.lastDeployedAt,
  lastError: env.lastError,
  public: env.public,
  status: env.status,
  url: envUrl(remoteUrl, subdomain, env.label),
});

/** The one text line an environment row reads as. */
const environmentLine = (row: {
  kind: string;
  label: string;
  lastDeploySha: string | null;
  public: boolean;
  status: string;
  url: string;
}): string =>
  `- ${row.label} (${row.kind}) ${row.url} — ${row.status}${row.public ? ", public" : ", members-only"}${row.lastDeploySha === null ? "" : `, ${sha10(row.lastDeploySha)}`}`;

const AppRef = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "App slug or id.",
});

const SourceRef = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "Branch, tag or commit SHA.",
});

const PathRef = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "Repository-relative path.",
});

const AppParams = Schema.Struct({ app: AppRef });

const EnvironmentRef = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "Environment label (e.g. staging) or id.",
});

/** A tool that takes nothing: `arguments` is accepted and ignored, and
 * `tools/list` still publishes a plain object — an empty `Schema.Struct`
 * renders as `{ "not": { "type": "null" } }`, which reads as no argument
 * contract at all. */
const NoArgs = Schema.Record(Schema.String, Schema.Json);

/** Every app-scoped read takes the same `app`, so the parser and its
 * description live in one place. */
const appParams = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ app: AppRef, ...fields });

const CreateSourceParams = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("blank").annotate({
      description: "An empty repository: push to deploy.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("github").annotate({
      description: "Import a public GitHub repository.",
    }),
    path: Schema.optional(
      Schema.String.check(Schema.isNonEmpty()).annotate({
        description:
          "Import only this folder of the repo (a monorepo package, e.g. apps/web) as the app's root, as one commit.",
      })
    ),
    ref: Schema.optional(SourceRef),
    url: Schema.String.annotate({
      description: "https://github.com/<owner>/<repo>",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("template").annotate({
      description: "One of the templates list_templates reports.",
    }),
    template: Schema.String.annotate({ description: "Template id." }),
  }),
]);

const CreateAppParams = Schema.Struct({
  name: Schema.optional(
    Schema.String.check(Schema.isNonEmpty()).annotate({
      description: "Display name (defaults to the slug).",
    })
  ),
  slug: Schema.String.check(Schema.isNonEmpty()).annotate({
    description: "App slug: lowercase letters, digits and hyphens, 1-48 chars.",
  }),
  source: Schema.optional(CreateSourceParams).annotate({
    description: "Where the app's code comes from; blank when omitted.",
  }),
});

/** The create argument as the create flow takes it: a template id is resolved
 * against the shipped list by `createAppForUser`, never by the client. */
const toCreateSource = (
  source?: Schema.Schema.Type<typeof CreateSourceParams>
): CreateSourceInput => {
  if (!source || source.kind === "blank") {
    return { kind: "blank" };
  }

  if (source.kind === "github") {
    return {
      kind: "git",
      path: source.path,
      ref: source.ref,
      url: source.url,
    };
  }

  return { id: source.template, kind: "template" };
};

/** The branch a commit targets, with the two preconditions the runner would
 * otherwise only discover mid-write: `base` is meaningless for a branch that
 * already exists, and `expectedTip` must match the tip the caller read. Both
 * refusals name the numbers an agent needs to retry. */
const checkedCommitTarget = (
  refs: GitRefs,
  wanted: string | undefined,
  base: string | undefined,
  wantedTip: string | undefined
) => {
  const branch = (wanted ?? "").trim() || refs.defaultBranch;
  const existing = refs.branches.find((row) => row.name === branch);
  const expectedTip = (wantedTip ?? "").trim();

  if (base !== undefined && existing) {
    throw refused(
      "invalid",
      `branch "${branch}" already exists at ${sha10(existing.sha)}; "base" only starts a branch that does not exist yet.`
    );
  }

  if (expectedTip === "") {
    return { branch, expectedTip };
  }

  if (!existing) {
    throw refused(
      "stale_tip",
      `branch "${branch}" does not exist, so it is not at ${expectedTip}.`
    );
  }

  // `expectedTip` may be abbreviated the way git prints one; seven characters
  // is the shortest unambiguous prefix git itself accepts.
  const atExpectedTip =
    existing.sha === expectedTip ||
    (expectedTip.length >= 7 && existing.sha.startsWith(expectedTip));

  if (!atExpectedTip) {
    throw refused(
      "stale_tip",
      `branch "${branch}" is at ${sha10(existing.sha)}, not ${expectedTip}.`
    );
  }

  return { branch, expectedTip };
};

/** The app one loop tool names, with a denial coded `forbidden` (the helper
 * stays the only place the gate is decided). */
const requireGatedApp = async (
  principal: KeyPrincipal,
  ref: string,
  need: AppRole
): Promise<{ app: RunnerApp; role: AppRole }> =>
  await denyAs(() => requireApp(principal, ref, need), "forbidden");

/** The deploy a commit triggered, if the runner has queued one: production's
 * row for the sha, else the row of the preview environment that tracks the
 * branch. `null` while nothing is queued yet — the caller then waits with
 * `wait_for_deploy` (the tip sweep has not run). */
const commitDeploy = async (
  app: RunnerApp,
  role: AppRole,
  branch: string,
  sha: string
): Promise<{ deploy: RunnerDeploy | null; environment: string | null }> => {
  const production = await runnerListDeploys(app.id);
  const direct = production.find((deploy) => deploy.sha === sha);

  if (direct) {
    return { deploy: direct, environment: null };
  }

  const environments = await appEnvironments(app.id, role);

  const tracked = environments.find(
    (env) => env.gitRef === `refs/heads/${branch}`
  );

  if (!tracked) {
    return { deploy: null, environment: null };
  }

  const rows = await runnerListDeploys(app.id, tracked.id);

  return {
    deploy: rows.find((deploy) => deploy.sha === sha) ?? null,
    environment: tracked.label,
  };
};

/** The preview environment that tracks a pull request's head branch, with the
 * deploy of its head commit: `get_pr`'s linked environment and its checks. */
const prPreview = async (
  app: RunnerApp,
  role: AppRole,
  head: string,
  headSha: string
): Promise<PreviewFacts | null> => {
  const environments = await appEnvironments(app.id, role);

  const env = environments.find(
    (candidate) => candidate.gitRef === `refs/heads/${head}`
  );

  if (!env) {
    return null;
  }

  const remote = await runnerGitRemote(app.id);
  const rows = await runnerListDeploys(app.id, env.id);

  return {
    deploy: rows.find((deploy) => deploy.sha === headSha) ?? null,
    label: env.label,
    lastError: env.lastError,
    url: envUrl(remote.url, app.subdomain, env.label),
  };
};

/** One pull request as the list and the merge tools report it: the fields an
 * agent acts on, in the same shape every tool answers. */
const prRow = (pr: PrSummary) => ({
  authorId: pr.authorId,
  base: pr.base,
  closedAt: pr.closedAt,
  commentCount: pr.commentCount,
  head: pr.head,
  headSha: pr.headSha,
  mergeSha: pr.mergeSha,
  number: pr.number,
  state: pr.state,
  title: pr.title,
  updatedAt: pr.updatedAt,
});

/** One pull request's detail: state, mergeability, reviews, checks and the
 * linked preview environment. */
const prDetailRow = (detail: PrDetail, preview: PreviewFacts | null) => {
  const pr = detail.pullRequest;
  const { compare } = detail;

  return {
    ahead: compare?.ahead ?? 0,
    approvals: detail.approvals,
    behind: compare?.behind ?? 0,
    checks: prChecks(detail, preview).map((check) => ({
      detail: check.detail,
      name: check.name,
      state: check.state,
    })),
    commits: compare?.commits.length ?? 0,
    conflicts: compare?.conflicts ?? [],
    environment:
      preview === null
        ? null
        : { deploy: preview.deploy, label: preview.label, url: preview.url },
    mergeState: detail.mergeState,
    mergeable: compare?.mergeable ?? false,
    pullRequest: prRow(pr),
    requirePr: detail.requirePr,
    requiredApprovals: detail.requiredApprovals,
    reviews: detail.reviews.map((review) => ({
      commitSha: review.commitSha,
      createdAt: review.createdAt,
      dismissedAt: review.dismissedAt,
      reviewerId: review.reviewerId,
      state: review.state,
    })),
    truncated: compare?.truncated ?? false,
  };
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  defineTool({
    description:
      "List the apps this account can see, with their slug, status and URL.",
    name: "list_apps",
    params: NoArgs,
    run: async ({ principal }) => {
      // A scoped key lists exactly its own apps: the set is filtered here,
      // where the list is built, so a tool later added to this table cannot
      // forget it.
      const visible = await listAppsForCollaborator(principal.userId);

      const apps = visible.filter((app) =>
        keyCoversApp(principal.scope, app.id)
      );

      if (apps.length === 0) {
        return {
          structured: { apps: [] },
          text: "No apps yet. Create one with create_app.",
        };
      }

      // One batched git.remote gives every app's public URL (the git base
      // carries the scheme and dev port) without a round trip per app.
      const remotes = await runnerRpcBatch<RunnerGitRemote>(
        apps.map((app) => ({ method: "git.remote", params: { id: app.id } }))
      );

      const rows = apps.map((app, index) => ({
        id: app.id,
        lastDeploySha: app.lastDeploySha,
        name: app.name,
        slug: app.slug,
        status: app.status,
        url: appUrl(remotes[index].url, app.subdomain),
      }));

      return {
        structured: { apps: rows },
        text: [
          `${rows.length} app${rows.length === 1 ? "" : "s"}:`,
          ...rows.map(
            (row) =>
              `- ${row.slug} — ${row.name}, ${row.status}${row.lastDeploySha ? `, deployed ${sha10(row.lastDeploySha)}` : ""} (${row.url})`
          ),
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "One app's details: status, access role, public URL and git remote.",
    name: "get_app",
    params: AppParams,
    run: async ({ principal }, { app: ref }) => {
      const { app, role } = await requireApp(principal, ref, "view");
      const remote = await runnerGitRemote(app.id);
      const url = appUrl(remote.url, app.subdomain);

      return {
        structured: { app: { ...app, role, url }, gitRemote: remote.url },
        text: `${app.slug} — ${app.name}\nstatus: ${app.status} (desired ${app.desiredState})\nrole: ${role}\nurl: ${url}\ngit: ${remote.url}${app.lastError === null ? "" : `\nlast error: ${app.lastError}`}`,
      };
    },
  }),
  defineTool({
    description: "List the app templates this Noite ships.",
    name: "list_templates",
    params: NoArgs,
    run: () => ({
      structured: {
        templates: TEMPLATES.map((template) => ({
          description: template.description,
          id: template.id,
          name: template.name,
          ref: template.ref,
          url: template.url,
        })),
      },
      text: TEMPLATES.map(
        (template) =>
          `- ${template.id} — ${template.name}: ${template.description}`
      ).join("\n"),
    }),
  }),
  defineTool({
    description:
      "Create an app: blank, imported from a public GitHub repo, or from a shipped template. Returns its id, URL, git remote and push instructions.",
    name: "create_app",
    params: CreateAppParams,
    run: async ({ principal }, { name, slug, source }) => {
      // A key limited to apps cannot create one: the new app would not be in
      // its set, so the push it advertises would be refused.
      if (principal.scope.appIds !== null) {
        throw new McpToolError(
          "This key is limited to specific apps, so it cannot create new ones. Create the app in the dashboard, or use an account-wide key."
        );
      }

      const normalized = slug.trim().toLowerCase();
      const problem = slugError(normalized);

      if (problem) {
        throw new McpToolError(problem, { invalid: true });
      }

      const actor = await keyActor(principal);

      const app = await createAppForUser({
        account: { id: actor.userId, name: actor.name },
        name: name?.trim() || normalized,
        slug: normalized,
        source: toCreateSource(source),
      });

      // A create may have adopted the caller's own earlier row (a retry
      // recovery); the app is only advertised if the key can administer it.
      const access = await keyAppVerdict(principal, { id: app.id }, "admin");

      if (access._tag !== "Granted") {
        throw new McpToolError(
          `Created ${app.slug}, but this key cannot administer it. Check the app's collaborators in the dashboard.`
        );
      }

      const remote = await runnerGitRemote(app.id);
      const url = appUrl(remote.url, app.subdomain);

      const pushInstructions = [
        "git init -b main",
        'git add -A && git commit -m "Initial commit"',
        `git remote add origin ${remote.url}`,
        'git push -u origin main  # username "git", password: your Noite API key',
      ].join("\n");

      return {
        structured: {
          app: {
            id: app.id,
            name: app.name,
            slug: app.slug,
            status: app.status,
            subdomain: app.subdomain,
          },
          gitRemote: remote.url,
          pushInstructions,
          url,
        },
        text: [
          `Created ${app.slug} (id ${app.id}), status ${app.status}.`,
          `URL: ${url}`,
          `Git remote: ${remote.url}`,
          pushInstructions,
          source?.kind === "blank" || source === undefined
            ? "It has no code yet: push a commit to deploy."
            : "The import runs in the background — poll deploy_status.",
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "An app's deploy state: status, whether it is live, and its recent deploys. `live` means the app is serving now, or is asleep and starts on the next request; a crash- or OOM-held fleet is not live. Pass `environment` for one preview environment instead of production. Poll this after a push.",
    name: "deploy_status",
    params: appParams({ environment: Schema.optional(EnvironmentRef) }),
    run: async ({ principal }, { app: ref, environment }) => {
      const { app, role } = await requireApp(principal, ref, "view");

      const env = environment
        ? await requireEnvironment(app, role, environment)
        : null;

      const deploys = await runnerRpc<RunnerDeploy[]>(
        "deploys.list",
        env === null ? { id: app.id } : { environmentId: env.id, id: app.id }
      );

      const recent = deploys.slice(0, 5);
      const latest = recent.at(0) ?? null;
      // An environment has no `subdomain`: its host is `<label>.<app host>`.
      const where = env === null ? app.slug : `${app.slug}/${env.label}`;
      const status = env === null ? app.status : env.status;
      const desiredState = env === null ? app.desiredState : env.desiredState;

      const lastDeploySha =
        env === null ? app.lastDeploySha : env.lastDeploySha;

      const lastError = env === null ? app.lastError : env.lastError;

      const live = deployStatusLive({
        desiredState,
        fleetHold: env === null ? app.fleetHold : null,
        status,
      });

      return {
        structured: {
          appId: app.id,
          deploy: latest,
          desiredState,
          environmentId: env?.id ?? null,
          lastDeploySha,
          live,
          name: app.name,
          recent,
          slug: app.slug,
          status,
        },
        text: [
          `${where}: ${status}${live ? " (live)" : ""}, desired ${desiredState}.`,
          lastError === null ? "" : `last error: ${lastError}`,
          ...recent.map(
            (deploy) =>
              `- ${deploy.id}: ${deploy.status}${deploy.sha === null ? "" : ` @ ${sha10(deploy.sha)}`} (${deploy.updatedAt})`
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "One deploy's build log — the newest deploy's unless `deployId` names another.",
    name: "deploy_log",
    params: appParams({
      deployId: Schema.optional(
        Schema.String.annotate({
          description: "Deploy id from deploy_status (defaults to the newest).",
        })
      ),
    }),
    run: async ({ principal }, { app: ref, deployId }) => {
      const { app } = await requireApp(principal, ref, "view");
      let wanted = deployId;

      if (!wanted) {
        const deploys = await runnerRpc<RunnerDeploy[]>("deploys.list", {
          id: app.id,
        });

        const [latest] = deploys;

        if (!latest) {
          throw new McpToolError(`${app.slug} has no deploys yet.`);
        }

        wanted = latest.id;
      }

      const { log } = await runnerDeployLog(app.id, wanted);

      return {
        structured: { appId: app.id, deployId: wanted, log, slug: app.slug },
        text: log === "" ? `${wanted}: no log output yet.` : log,
      };
    },
  }),
  defineTool({
    description:
      "The app's recent runtime log lines (the tail of the merged build and runtime log). Pass `environment` for one preview environment's logs instead of production's.",
    name: "app_logs",
    params: appParams({
      environment: Schema.optional(EnvironmentRef),
      limit: Schema.optional(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(1000)
        ).annotate({
          description: "How many trailing lines to return (default 200).",
        })
      ),
    }),
    run: async ({ principal }, { app: ref, environment, limit }) => {
      const { app, role } = await requireApp(principal, ref, "view");

      const env = environment
        ? await requireEnvironment(app, role, environment)
        : null;

      const all = await runnerRpc<string[]>("logs.get", {
        environmentId: env?.id,
        id: app.id,
      });

      const lines = all.slice(-(limit ?? 200));
      const where = env === null ? app.slug : `${app.slug}/${env.label}`;

      return {
        structured: {
          appId: app.id,
          environmentId: env?.id ?? null,
          lines,
          slug: app.slug,
          total: all.length,
        },
        text: lines.length === 0 ? `${where}: no log lines.` : lines.join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "The app's error issues grouped by fingerprint, with 24-hour counts. Pass `environment` for one preview environment's issues instead of production's.",
    name: "app_errors",
    params: appParams({
      environment: Schema.optional(EnvironmentRef),
      status: Schema.optional(
        Schema.Literals(["open", "resolved", "ignored"]).annotate({
          description: "Which issues to list (default open).",
        })
      ),
    }),
    run: async ({ principal }, { app: ref, environment, status }) => {
      const { app, role } = await requireApp(principal, ref, "view");

      const env = environment
        ? await requireEnvironment(app, role, environment)
        : null;

      const list = await runnerRpc<RunnerErrorList>("errors.list", {
        environmentId: env?.id,
        id: app.id,
        status: status ?? "open",
      });

      const issues = list.issues.slice(0, 50).map((issue) => ({
        count: issue.count,
        culprit: issue.culprit,
        fingerprint: issue.fingerprint,
        kind: issue.kind,
        lastSeenUs: issue.lastSeenUs,
        message: issue.message,
        status: issue.status,
      }));

      const where = env === null ? app.slug : `${app.slug}/${env.label}`;
      const counts = `${list.counts.open} open, ${list.counts.resolved} resolved, ${list.counts.ignored} ignored`;

      return {
        structured: {
          appId: app.id,
          counts: list.counts,
          environmentId: env?.id ?? null,
          issues,
          slug: app.slug,
        },
        text:
          issues.length === 0
            ? `${where}: no ${status ?? "open"} errors (${counts}).`
            : [
                `${issues.length} ${status ?? "open"} error issue${issues.length === 1 ? "" : "s"} in ${where} (${counts}):`,
                ...issues.map(
                  (issue) =>
                    `- [${issue.count}×] ${issue.message} (${issue.kind}${issue.culprit === "" ? "" : ` at ${issue.culprit}`}, ${issue.fingerprint})`
                ),
              ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "An app's environment variables. Values are hidden unless they are 0/1 flags, exactly as the UI shows them.",
    name: "env_list",
    params: AppParams,
    run: async ({ principal }, { app: ref }) => {
      const { app } = await requireApp(principal, ref, "view");
      const rows = await runnerListEnv(app.id);

      const env = rows.map((row) => {
        const { name, updatedAt, value } = redactEnv(row);

        return { name, updatedAt, value };
      });

      return {
        structured: { appId: app.id, env, slug: app.slug },
        text:
          env.length === 0
            ? `${app.slug}: no environment variables.`
            : env
                .map(
                  (row) =>
                    `${row.name}=${row.value === "" ? "<hidden>" : row.value}`
                )
                .join("\n"),
      };
    },
  }),
  defineTool({
    description: "Set an app environment variable (needs the admin role).",
    name: "env_set",
    params: appParams({
      key: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Variable name.",
      }),
      value: Schema.String.annotate({ description: "Variable value." }),
    }),
    run: async ({ principal }, { app: ref, key, value }) => {
      const { app } = await requireApp(principal, ref, "admin");
      await runnerSetEnv(app.id, key, value);

      return {
        structured: { appId: app.id, key, ok: true, slug: app.slug },
        text: `Set ${key} on ${app.slug}. The next deploy picks it up.`,
      };
    },
  }),
  defineTool({
    description: "Remove an app environment variable (needs the admin role).",
    name: "env_unset",
    params: appParams({
      key: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Variable name.",
      }),
    }),
    run: async ({ principal }, { app: ref, key }) => {
      const { app } = await requireApp(principal, ref, "admin");
      await runnerDeleteEnv(app.id, key);

      return {
        structured: { appId: app.id, key, ok: true, slug: app.slug },
        text: `Removed ${key} from ${app.slug}.`,
      };
    },
  }),
  defineTool({
    description:
      "List an app's preview environments: label, what each tracks, status, URL and whether it is public. An environment is members-only unless made public. `main` is the app itself, never an environment.",
    name: "list_environments",
    params: AppParams,
    run: async ({ principal }, { app: ref }) => {
      const { app, role } = await requireApp(principal, ref, "view");
      const environments = await appEnvironments(app.id, role);
      const remote = await runnerGitRemote(app.id);

      const rows = environments.map((env) =>
        environmentRow(env, app.subdomain, remote.url)
      );

      return {
        structured: { appId: app.id, environments: rows, slug: app.slug },
        text:
          rows.length === 0
            ? `${app.slug}: no environments. Create one from a branch with create_environment.`
            : [
                `${rows.length} environment${rows.length === 1 ? "" : "s"} in ${app.slug}:`,
                ...rows.map((row) => environmentLine(row)),
              ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Create a preview environment from a branch and deploy its head: its own host, its own empty storage. `main` is the app itself and is refused, and the label is derived from the branch name.",
    name: "create_environment",
    params: appParams({
      branch: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "A branch of the app's repository (not main).",
      }),
    }),
    run: async ({ principal }, { app: ref, branch }) => {
      const { app, role } = await requireApp(principal, ref, "push");
      const env = await runnerEnvironmentCreate(app.id, branch, role);
      const remote = await runnerGitRemote(app.id);
      const row = environmentRow(env, app.subdomain, remote.url);

      return {
        structured: { appId: app.id, environment: row, slug: app.slug },
        text: [
          `Created ${row.label} in ${app.slug} from ${branch}.`,
          environmentLine(row),
          `The branch head is deploying now — poll deploy_status with environment ${row.label}.`,
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Delete one preview environment: its fleet is stopped and its storage, host and deploys are gone.",
    name: "delete_environment",
    params: appParams({ environment: EnvironmentRef }),
    run: async ({ principal }, { app: ref, environment }) => {
      const { app, role } = await requireApp(principal, ref, "admin");
      const env = await requireEnvironment(app, role, environment);
      await runnerEnvironmentDelete(app.id, env.id, role);

      return {
        structured: {
          appId: app.id,
          deleted: env.label,
          environmentId: env.id,
          ok: true,
          slug: app.slug,
        },
        text: `Deleted ${env.label} from ${app.slug}: its fleet, storage and host are gone.`,
      };
    },
  }),
  defineTool({
    description:
      "Re-deploy one preview environment at its ref's current head (the same commit rebuilds).",
    name: "deploy_environment",
    params: appParams({ environment: EnvironmentRef }),
    run: async ({ principal }, { app: ref, environment }) => {
      const { app, role } = await requireApp(principal, ref, "push");
      const env = await requireEnvironment(app, role, environment);

      const actor = await keyActor(principal);

      const result = await runnerEnvironmentDeploy(
        app.id,
        env.id,
        role,
        actor.name
      );

      return {
        structured: {
          appId: app.id,
          deployId: result.deployId,
          environmentId: env.id,
          sha: result.sha,
          slug: app.slug,
        },
        text: `Deploying ${env.label} at ${sha10(result.sha)} (deploy ${result.deployId}) — read it with deploy_log.`,
      };
    },
  }),
  defineTool({
    description:
      "Make one preview environment public (anyone with the URL) or members-only again (the default).",
    name: "set_environment_public",
    params: appParams({
      environment: EnvironmentRef,
      public: Schema.Boolean.annotate({
        description:
          "true = anyone with the URL can open it; false = collaborators only.",
      }),
    }),
    run: async ({ principal }, { app: ref, environment, public: isPublic }) => {
      const { app, role } = await requireApp(principal, ref, "admin");
      const before = await requireEnvironment(app, role, environment);

      const env = await runnerEnvironmentUpdate(
        app.id,
        before.id,
        isPublic,
        role
      );

      const remote = await runnerGitRemote(app.id);
      const row = environmentRow(env, app.subdomain, remote.url);

      return {
        structured: { appId: app.id, environment: row, slug: app.slug },
        text: `${row.label} is now ${isPublic ? "public" : "members-only"}: ${row.url}`,
      };
    },
  }),
  defineTool({
    description:
      "One preview environment's variable overrides. App variables are inherited; these win for this environment only. Values are hidden unless they are 0/1 flags, exactly as the UI shows them.",
    name: "environment_env_list",
    params: appParams({ environment: EnvironmentRef }),
    run: async ({ principal }, { app: ref, environment }) => {
      const { app, role } = await requireApp(principal, ref, "view");
      const env = await requireEnvironment(app, role, environment);
      const rows = await runnerEnvironmentVars(app.id, env.id, role);

      const env2 = rows.map((row) => {
        const { name, updatedAt, value } = redactEnv(row);

        return { name, updatedAt, value };
      });

      return {
        structured: {
          appId: app.id,
          environmentId: env.id,
          label: env.label,
          overrides: env2,
          slug: app.slug,
        },
        text:
          env2.length === 0
            ? `${app.slug}/${env.label}: no overrides (it inherits the app's variables).`
            : env2
                .map(
                  (row) =>
                    `${row.name}=${row.value === "" ? "<hidden>" : row.value}`
                )
                .join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Set a variable override on one preview environment (needs the push role). The environment inherits the app's variables; this name wins for it alone.",
    name: "environment_env_set",
    params: appParams({
      environment: EnvironmentRef,
      key: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Variable name.",
      }),
      value: Schema.String.annotate({ description: "Variable value." }),
    }),
    run: async ({ principal }, { app: ref, environment, key, value }) => {
      const { app, role } = await requireApp(principal, ref, "push");
      const env = await requireEnvironment(app, role, environment);
      await runnerEnvironmentVarSet(app.id, env.id, key, value, role);

      return {
        structured: {
          appId: app.id,
          environmentId: env.id,
          key,
          label: env.label,
          ok: true,
          slug: app.slug,
        },
        text: `Set ${key} on ${app.slug}/${env.label}. The next deploy of that environment picks it up.`,
      };
    },
  }),
  defineTool({
    description:
      "Remove a variable override from one preview environment, so the name falls back to the app's value (needs the push role).",
    name: "environment_env_unset",
    params: appParams({
      environment: EnvironmentRef,
      key: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Variable name.",
      }),
    }),
    run: async ({ principal }, { app: ref, environment, key }) => {
      const { app, role } = await requireApp(principal, ref, "push");
      const env = await requireEnvironment(app, role, environment);
      await runnerEnvironmentVarDelete(app.id, env.id, key, role);

      return {
        structured: {
          appId: app.id,
          environmentId: env.id,
          key,
          label: env.label,
          ok: true,
          slug: app.slug,
        },
        text: `Removed ${key} from ${app.slug}/${env.label}.`,
      };
    },
  }),
  defineTool({
    description:
      "The app's branches: tip, last commit and distance from the default branch.",
    name: "repo_branches",
    params: AppParams,
    run: async ({ principal }, { app: ref }) => {
      const { app } = await requireApp(principal, ref, "view");
      const refs: GitRefs = await runnerGitRefs(app.id);

      return {
        structured: { appId: app.id, refs, slug: app.slug },
        text: [
          `${app.slug}: default ${refs.defaultBranch}${refs.deployedSha === null ? ", nothing deployed" : `, deployed ${sha10(refs.deployedSha)}`}.`,
          ...refs.branches.map(
            (branch) =>
              `- ${branch.name} ${sha10(branch.sha)} "${branch.subject}" ${branch.authorName}, ${iso(branch.committedAt)}${branch.name === refs.defaultBranch ? "" : ` (+${branch.ahead}/-${branch.behind} vs ${refs.defaultBranch})`}`
          ),
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "The app's file tree at a ref (default: what is deployed, else the default branch).",
    name: "repo_tree",
    params: appParams({ ref: Schema.optional(SourceRef) }),
    run: async ({ principal }, { app: ref, ref: revision }) => {
      const { app } = await requireApp(principal, ref, "view");
      const tree: RunnerTree = await runnerSourceTree(app.id, revision);

      return {
        structured: {
          appId: app.id,
          ref: revision ?? null,
          slug: app.slug,
          tree,
        },
        text: [
          `${app.slug} at ${sha10(tree.sha)}${revision ? ` (${revision})` : ""}: ${tree.files.length} file${tree.files.length === 1 ? "" : "s"}${tree.truncated ? ", truncated" : ""}.`,
          ...tree.files.map((file) => `- ${file.path} (${file.size} B)`),
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "One file's contents at a ref (default: what is deployed, else the default branch).",
    name: "repo_file",
    params: appParams({ path: PathRef, ref: Schema.optional(SourceRef) }),
    run: async ({ principal }, { app: ref, path, ref: revision }) => {
      const { app } = await requireApp(principal, ref, "view");
      const blob: RunnerBlob = await runnerSourceBlob(app.id, path, revision);
      let note = "";

      if (blob.binary) {
        note = " (binary: contents omitted)";
      } else if (blob.truncated) {
        note = " (truncated)";
      }

      return {
        structured: {
          appId: app.id,
          blob,
          ref: revision ?? null,
          slug: app.slug,
        },
        text: `# ${blob.path} @ ${sha10(blob.sha)} (${blob.size} B)${note}\n${blob.text}`,
      };
    },
  }),
  defineTool({
    description:
      "The app's commit history, newest first, optionally scoped to a path.",
    name: "repo_log",
    params: appParams({
      path: Schema.optional(PathRef).annotate({
        description: "Only commits touching this path.",
      }),
      ref: Schema.optional(SourceRef),
      skip: Schema.optional(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(0)
        ).annotate({
          description: "How many commits to skip (page with nextSkip).",
        })
      ),
    }),
    run: async ({ principal }, { app: ref, path, ref: revision, skip }) => {
      const { app } = await requireApp(principal, ref, "view");

      const log: GitLog = await runnerGitLog(app.id, {
        path,
        ref: revision,
        skip,
      });

      const structured = {
        appId: app.id,
        log,
        path: path ?? null,
        ref: revision ?? null,
        slug: app.slug,
      };

      if (log.commits.length === 0) {
        return {
          structured,
          text: `${app.slug}: no commits${path === undefined ? "" : ` touching ${path}`}.`,
        };
      }

      const tail = log.nextSkip === null ? [] : [`next: skip ${log.nextSkip}`];

      return {
        structured,
        text: [
          ...log.commits.map(
            (commit) =>
              `- ${sha10(commit.sha)} ${commit.subject} — ${commit.authorName}, ${iso(commit.authoredAt)}`
          ),
          ...tail,
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "One commit: metadata, its changed files and the patch against its first parent.",
    name: "repo_commit",
    params: appParams({
      sha: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Commit SHA (7-40 hex chars).",
      }),
    }),
    run: async ({ principal }, { app: ref, sha }) => {
      const { app } = await requireApp(principal, ref, "view");
      const detail: GitCommitDetail = await runnerGitCommit(app.id, sha);

      return {
        structured: { appId: app.id, detail, slug: app.slug },
        text: [
          `commit ${detail.commit.sha}`,
          `Author: ${detail.commit.authorName} <${detail.commit.authorEmail}>`,
          `Date: ${iso(detail.commit.authoredAt)}`,
          "",
          detail.commit.subject,
          detail.body,
          "",
          ...detail.files.map(
            (file) =>
              `${file.status} ${file.path}${file.additions === null ? " (binary)" : ` (+${file.additions}/-${file.deletions})`}`
          ),
          "",
          detail.patch,
          detail.truncated ? "(patch truncated)" : "",
        ].join("\n"),
      };
    },
  }),

  // ---- The agent loop: write, review, ship ----
  //
  // The write half of the loop (code → pull request → preview → merge →
  // deploy → rollback) with no UI in it. Every tool resolves its app through
  // `requireGatedApp` (the one gate, whose effective role the runner trusts),
  // forwards that role, and answers a refusal an agent can act on
  // (`refusals.ts`): a protected branch, a tip that moved, a pull request that
  // will not merge, a role it does not hold.

  defineTool({
    description:
      "Commit file writes, deletes and moves to a branch — creating that branch from `base` when it does not exist yet — and answer the commit sha plus the deploy it triggered. `expectedTip` is the compare-and-set: the commit is refused if the branch moved since you read it.",
    name: "commit_files",
    params: appParams({
      base: Schema.optional(SourceRef).annotate({
        description:
          "Ref a new branch starts from (default: the default branch). Only for a branch that does not exist yet.",
      }),
      branch: Schema.optional(
        Schema.String.check(Schema.isNonEmpty()).annotate({
          description:
            "Branch to commit to (default: the app's default branch). A branch that does not exist is created.",
        })
      ),
      deletes: Schema.optional(
        Schema.Array(PathRef).annotate({
          description: "Repository-relative paths to remove.",
        })
      ),
      expectedTip: Schema.optional(SourceRef).annotate({
        description:
          "Compare-and-set: refuse the commit unless the branch is still at this commit.",
      }),
      files: Schema.optional(
        Schema.Array(
          Schema.Struct({
            content: Schema.String.annotate({
              description:
                "File contents: text, or base64 bytes when `encoding` is base64.",
            }),
            // The runner's wire value is `utf8` (`WebEncoding`), not a WHATWG
            // label: `utf-8` would never be accepted.
            // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- see above.
            encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
            path: PathRef,
          })
        ).annotate({ description: "Files to write (add or replace)." })
      ),
      message: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Commit message (1-500 chars).",
      }),
      moves: Schema.optional(
        Schema.Array(Schema.Struct({ from: PathRef, to: PathRef })).annotate({
          description: "Files to move without re-reading them.",
        })
      ),
    }),
    run: async (
      { principal },
      {
        app: ref,
        base,
        branch: wantedBranch,
        deletes: wantedDeletes,
        expectedTip: wantedTip,
        files: wantedFiles,
        message,
        moves: wantedMoves,
      }
    ) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const files = [...(wantedFiles ?? [])];
      const moves = [...(wantedMoves ?? [])];
      const deletes = [...(wantedDeletes ?? [])];

      if (files.length === 0 && moves.length === 0 && deletes.length === 0) {
        throw new McpToolError(
          "commit_files needs at least one `files`, `moves` or `deletes` entry.",
          { invalid: true }
        );
      }

      const refs = await runnerGitRefs(app.id);

      const { branch, expectedTip } = checkedCommitTarget(
        refs,
        wantedBranch,
        base,
        wantedTip
      );

      const body: SourceCommitBody = {
        actor: await keyActor(principal),
        branch,
        files,
        message,
        role,
      };

      if (base !== undefined) {
        body.fromSha = base;
      }

      if (deletes.length > 0) {
        body.deletes = deletes;
      }

      if (expectedTip !== "") {
        body.expectedTip = expectedTip;
      }

      if (moves.length > 0) {
        body.moves = moves;
      }

      const { sha } = await attempt(() => runnerSourceCommit(app.id, body));
      const triggered = await commitDeploy(app, role, branch, sha);

      const where =
        triggered.environment === null
          ? app.slug
          : `${app.slug}/${triggered.environment}`;

      return {
        structured: {
          appId: app.id,
          branch,
          deletes: deletes.length,
          deploy: triggered.deploy,
          environment: triggered.environment,
          files: files.length + moves.length,
          sha,
          slug: app.slug,
        },
        text: [
          `${where}: committed ${sha10(sha)} to ${branch} — ${files.length} written, ${moves.length} moved, ${deletes.length} deleted.`,
          triggered.deploy === null
            ? "No deploy is queued yet: wait_for_deploy with this sha follows it when the runner starts it."
            : `Deploy ${triggered.deploy.id} is ${triggered.deploy.status} — follow it with wait_for_deploy (sha ${sha10(sha)}).`,
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Create a branch at a ref or commit, without touching the default branch. An existing name is refused (branch_exists).",
    name: "create_branch",
    params: appParams({
      from: Schema.optional(SourceRef).annotate({
        description:
          "Ref or commit the branch starts at (default: the default branch's head).",
      }),
      name: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "New branch name (no spaces or '..').",
      }),
    }),
    run: async ({ principal }, { app: ref, from, name }) => {
      const { app } = await requireGatedApp(principal, ref, "push");
      const refs = await runnerGitRefs(app.id);
      const existing = refs.branches.find((row) => row.name === name);

      if (existing) {
        throw refused(
          "branch_exists",
          `branch "${name}" already exists at ${sha10(existing.sha)}.`
        );
      }

      const start = (from ?? "").trim() || refs.defaultBranch;

      const created = await attempt(() =>
        runnerGitBranchCreate(app.id, name, start)
      );

      return {
        structured: { appId: app.id, branch: created, slug: app.slug },
        text: `Created ${name} in ${app.slug} at ${sha10(created.sha)} (from ${start}). Commit to it with commit_files.`,
      };
    },
  }),
  defineTool({
    description:
      "Delete a branch and its preview environment. The default branch is refused (protected_branch).",
    name: "delete_branch",
    params: appParams({
      name: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Branch to delete.",
      }),
    }),
    run: async ({ principal }, { app: ref, name }) => {
      const { app } = await requireGatedApp(principal, ref, "admin");
      const refs = await runnerGitRefs(app.id);

      if (name === refs.defaultBranch) {
        throw refused(
          "protected_branch",
          `"${name}" is the default branch and cannot be deleted.`
        );
      }

      await attempt(() => runnerGitBranchDelete(app.id, name));

      return {
        structured: {
          appId: app.id,
          deleted: name,
          ok: true,
          slug: app.slug,
        },
        text: `Deleted ${name} from ${app.slug}; its preview environment, if it had one, is gone too.`,
      };
    },
  }),
  defineTool({
    description:
      "Pull requests for this app, newest first, with the open/closed/merged counts. `state` filters the list (default all).",
    name: "list_prs",
    params: appParams({
      limit: Schema.optional(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(100)
        ).annotate({ description: "How many to return (default 30)." })
      ),
      skip: Schema.optional(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(0)
        ).annotate({ description: "How many to skip (paging)." })
      ),
      state: Schema.optional(
        Schema.Literals(["all", "closed", "merged", "open"]).annotate({
          description: "Which pull requests to list (default all).",
        })
      ),
    }),
    run: async ({ principal }, { app: ref, limit, skip, state }) => {
      const { app } = await requireGatedApp(principal, ref, "view");

      const list = await runnerPrsList(app.id, {
        limit: limit ?? 30,
        skip,
        state,
      });

      const rows = list.pullRequests.map(prRow);
      const counts = `${list.counts.open} open, ${list.counts.closed} closed, ${list.counts.merged} merged`;

      return {
        structured: {
          appId: app.id,
          counts: list.counts,
          pullRequests: rows,
          slug: app.slug,
        },
        text:
          rows.length === 0
            ? `${app.slug}: no ${state ?? "all"} pull requests (${counts}).`
            : [
                `${rows.length} pull request${rows.length === 1 ? "" : "s"} in ${app.slug} (${counts}):`,
                ...list.pullRequests.map(
                  (pr) =>
                    `- #${pr.number} ${pr.title} — ${pr.state}, ${pr.head} → ${pr.base} @ ${sha10(pr.headSha)}, ${pr.commentCount} comment${pr.commentCount === 1 ? "" : "s"}`
                ),
              ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "One pull request: state, mergeability, reviews, approvals, the checks that gate merging, and the preview environment that tracks its head branch.",
    name: "get_pr",
    params: appParams({
      number: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1)
      ).annotate({ description: "Pull request number." }),
    }),
    run: async ({ principal }, { app: ref, number }) => {
      const { app, role } = await requireGatedApp(principal, ref, "view");
      const detail = await attempt(() => runnerPrGet(app.id, number));

      const preview = await prPreview(
        app,
        role,
        detail.pullRequest.head,
        detail.pullRequest.headSha
      );

      const row = prDetailRow(detail, preview);

      return {
        structured: { ...row, appId: app.id, slug: app.slug },
        text: [
          `${app.slug} #${number} ${detail.pullRequest.title} — ${detail.pullRequest.state}, ${detail.pullRequest.head} → ${detail.pullRequest.base} @ ${sha10(detail.pullRequest.headSha)}`,
          `merge: ${detail.mergeState} (${detail.approvals}/${detail.requiredApprovals} approvals${detail.requirePr ? ", pull requests required" : ""})`,
          `checks: ${row.checks.map((check) => `${check.name}=${check.state}`).join(", ")}`,
          ...(row.conflicts.length === 0
            ? []
            : [`conflicts: ${row.conflicts.join(", ")}`]),
          ...(preview === null
            ? []
            : [
                `preview: ${preview.label} at ${preview.url}${preview.deploy === null ? " (nothing deployed yet)" : ` — deploy ${preview.deploy.status}`}`,
              ]),
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Open a pull request from a branch (needs the push role). Fails when the branches are the same, a branch is missing, or an open pull request already exists for the pair.",
    name: "create_pr",
    params: appParams({
      base: Schema.optional(SourceRef).annotate({
        description:
          "Branch to merge into (default: the app's default branch).",
      }),
      body: Schema.optional(Schema.String).annotate({
        description: "Description (Markdown).",
      }),
      head: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Branch with the changes.",
      }),
      title: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Title.",
      }),
    }),
    run: async ({ principal }, { app: ref, base, body, head, title }) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const refs = await runnerGitRefs(app.id);
      const actor = await keyActor(principal);

      const detail = await attempt(() =>
        runnerPrCreate(app.id, {
          actor,
          base: (base ?? "").trim() || refs.defaultBranch,
          body,
          head,
          title,
        })
      );

      const preview = await prPreview(
        app,
        role,
        detail.pullRequest.head,
        detail.pullRequest.headSha
      );

      const row = prDetailRow(detail, preview);

      return {
        structured: { ...row, appId: app.id, slug: app.slug },
        text: [
          `Opened #${detail.pullRequest.number} in ${app.slug}: ${title} (${head} → ${detail.pullRequest.base}).`,
          `merge: ${detail.mergeState}; checks: ${row.checks.map((check) => `${check.name}=${check.state}`).join(", ")}`,
          "Comment with comment_pr, review with review_pr, merge with merge_pr.",
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Comment on a pull request's conversation, or on one diff line when `path`, `line`, `side` and `sha` are all given (needs the push role).",
    name: "comment_pr",
    params: appParams({
      body: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Comment text (Markdown).",
      }),
      line: Schema.optional(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1)
        ).annotate({
          description: "Diff line number (with `path` and `side`).",
        })
      ),
      number: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1)
      ).annotate({ description: "Pull request number." }),
      path: Schema.optional(PathRef).annotate({
        description: "Repo-relative file the line belongs to.",
      }),
      sha: Schema.optional(SourceRef).annotate({
        description: "The head commit the line anchors to (the PR's headSha).",
      }),
      side: Schema.optional(
        Schema.Literals(["new", "old"]).annotate({
          description: "Which side of the diff the line is on.",
        })
      ),
    }),
    run: async (
      { principal },
      { app: ref, body, line, number, path, sha, side }
    ) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const actor = await keyActor(principal);

      const comment = await attempt(() =>
        runnerPrComment(app.id, number, {
          actor,
          body,
          commitSha: sha,
          line,
          path,
          role,
          side,
        })
      );

      return {
        structured: { appId: app.id, comment, slug: app.slug },
        text: `Commented on #${number} in ${app.slug}${path === undefined ? "" : ` (${path}${line === undefined ? "" : `:${line}`})`} — ${comment.id}.`,
      };
    },
  }),
  defineTool({
    description:
      "Approve a pull request or request changes (needs the push role). Nobody reviews their own pull request; say why with comment_pr.",
    name: "review_pr",
    params: appParams({
      number: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1)
      ).annotate({ description: "Pull request number." }),
      state: Schema.Literals(["approved", "changes_requested"]).annotate({
        description: "`approved` lets it merge; `changes_requested` blocks it.",
      }),
    }),
    run: async ({ principal }, { app: ref, number, state }) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const actor = await keyActor(principal);

      const detail = await attempt(() =>
        runnerPrReview(app.id, number, { actor, role, state })
      );

      const preview = await prPreview(
        app,
        role,
        detail.pullRequest.head,
        detail.pullRequest.headSha
      );

      return {
        structured: {
          ...prDetailRow(detail, preview),
          appId: app.id,
          slug: app.slug,
        },
        text: `Recorded ${state.replace("_", " ")} on #${number} in ${app.slug}. merge: ${detail.mergeState} (${detail.approvals}/${detail.requiredApprovals} approvals).`,
      };
    },
  }),
  defineTool({
    description:
      "Squash-merge a pull request into its base branch (needs the push role). Branch protection is enforced: the merge is refused on conflicts, a missing branch, or too few approvals. The merge deploy follows on the base branch.",
    name: "merge_pr",
    params: appParams({
      deleteBranch: Schema.optional(Schema.Boolean).annotate({
        description: "Delete the head branch (and its preview) after merging.",
      }),
      message: Schema.optional(Schema.String).annotate({
        description:
          "Merge commit body (default: the branch's commit subjects).",
      }),
      number: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1)
      ).annotate({ description: "Pull request number." }),
      title: Schema.optional(Schema.String).annotate({
        description: "Merge commit title (default: the pull request's title).",
      }),
    }),
    run: async (
      { principal },
      { app: ref, deleteBranch, message, number, title }
    ) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const actor = await keyActor(principal);
      const before = await attempt(() => runnerPrGet(app.id, number));

      const authorName =
        (await userDisplayName(before.pullRequest.authorId)) || undefined;

      const detail = await attempt(() =>
        runnerPrMerge(app.id, number, {
          actor,
          authorName,
          deleteBranch,
          message,
          role,
          title,
        })
      );

      const preview = await prPreview(
        app,
        role,
        detail.pullRequest.head,
        detail.pullRequest.headSha
      );

      const mergeSha = detail.pullRequest.mergeSha ?? "";

      return {
        structured: {
          ...prDetailRow(detail, preview),
          appId: app.id,
          mergeSha: detail.pullRequest.mergeSha,
          slug: app.slug,
        },
        text: [
          `Merged #${number} into ${detail.pullRequest.base} as ${sha10(mergeSha)}${deleteBranch ? `, deleting ${detail.pullRequest.head}` : ""}.`,
          `The deploy of ${detail.pullRequest.base} starts now — wait_for_deploy with sha ${mergeSha} follows it.`,
        ].join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "Close a pull request without merging it (needs the push role). It stays closed until reopened in the UI.",
    name: "close_pr",
    params: appParams({
      number: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1)
      ).annotate({ description: "Pull request number." }),
    }),
    run: async ({ principal }, { app: ref, number }) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const actor = await keyActor(principal);

      const detail = await attempt(() =>
        runnerPrUpdate(app.id, number, { actor, role, state: "closed" })
      );

      return {
        structured: {
          appId: app.id,
          pullRequest: prRow(detail.pullRequest),
          slug: app.slug,
        },
        text: `Closed #${number} in ${app.slug} (${detail.pullRequest.head} → ${detail.pullRequest.base}).`,
      };
    },
  }),
  defineTool({
    description:
      "Re-run a previous successful deploy's sha — production, or one preview environment with `environment` (needs the push role). The runner proves the sha was successful in that target.",
    name: "rollback",
    params: appParams({
      environment: Schema.optional(EnvironmentRef).annotate({
        description: "Preview environment to roll back (default: production).",
      }),
      sha: SourceRef,
    }),
    run: async ({ principal }, { app: ref, environment, sha }) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");

      const env =
        environment === undefined
          ? null
          : await denyAs(
              () => requireEnvironment(app, role, environment),
              "not_found"
            );

      const result = await attempt(() =>
        runnerRollback(app.id, sha, env?.id ?? "", role)
      );

      const where = env === null ? app.slug : `${app.slug}/${env.label}`;

      return {
        structured: {
          appId: app.id,
          deployId: result.deployId,
          environment: env?.label ?? null,
          ok: result.ok,
          sha: result.sha,
          slug: app.slug,
        },
        text: `Rolling ${where} back to ${sha10(result.sha)} (deploy ${result.deployId}) — wait_for_deploy follows it.`,
      };
    },
  }),
  defineTool({
    description:
      "Re-run the deploy that is live now (the UI's Redeploy), at the sha production is serving. Nothing deployed yet is refused (no_deploy).",
    name: "redeploy",
    params: AppParams,
    run: async ({ principal }, { app: ref }) => {
      const { app, role } = await requireGatedApp(principal, ref, "push");
      const live = app.lastDeploySha;

      if (live === null) {
        throw refused(
          "no_deploy",
          `${app.slug} has no successful deploy to re-run; commit to its default branch first.`
        );
      }

      const result = await attempt(() =>
        runnerRollback(app.id, live, "", role)
      );

      return {
        structured: {
          appId: app.id,
          deployId: result.deployId,
          environment: null,
          ok: result.ok,
          sha: result.sha,
          slug: app.slug,
        },
        text: `Re-deploying ${app.slug} at ${sha10(result.sha)} (deploy ${result.deployId}) — wait_for_deploy follows it.`,
      };
    },
  }),
  defineTool({
    description:
      "Stop an in-flight deploy (needs the push role). The runner kills the running step and closes the deploy as cancelled; a deploy that already finished is refused (not_open).",
    name: "cancel_deploy",
    params: appParams({
      deployId: Schema.String.check(Schema.isNonEmpty()).annotate({
        description: "Deploy id from deploy_status.",
      }),
    }),
    run: async ({ principal }, { app: ref, deployId }) => {
      const { app } = await requireGatedApp(principal, ref, "push");

      const result = await attempt(() => runnerCancelDeploy(app.id, deployId));

      return {
        structured: {
          appId: app.id,
          deployId,
          ok: result.ok,
          slug: app.slug,
        },
        text: `Cancelled deploy ${deployId} in ${app.slug}.`,
      };
    },
  }),
  defineTool({
    description:
      "Wait for a deploy to finish: one bounded long poll (at most `maxWaitSeconds`, default 25) that answers as soon as the row is terminal, or with the row it last saw and a resume hint. The transport is stateless — call it again to keep waiting.",
    name: "wait_for_deploy",
    params: appParams({
      deployId: Schema.optional(
        Schema.String.check(Schema.isNonEmpty()).annotate({
          description: "Wait for this deploy id (default: the newest row).",
        })
      ),
      environment: Schema.optional(EnvironmentRef).annotate({
        description:
          "Wait on one preview environment's deploy (default: production).",
      }),
      maxWaitSeconds: Schema.optional(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(MAX_WAIT_SECONDS)
        ).annotate({
          description: `How long this call waits, at most ${MAX_WAIT_SECONDS} seconds (default 25).`,
        })
      ),
      sha: Schema.optional(SourceRef).annotate({
        description:
          "Wait for the deploy of this commit instead of the newest row.",
      }),
    }),
    run: async (
      { principal },
      { app: ref, deployId, environment, maxWaitSeconds, sha }
    ) => {
      const { app, role } = await requireGatedApp(principal, ref, "view");

      const env =
        environment === undefined
          ? null
          : await denyAs(
              () => requireEnvironment(app, role, environment),
              "not_found"
            );

      const environmentId = env?.id ?? "";
      const budgetSeconds = maxWaitSeconds ?? 25;
      let wanted = "no deploy row";

      if (deployId !== undefined) {
        wanted = `deploy ${deployId}`;
      } else if (sha !== undefined) {
        wanted = `the deploy of ${sha}`;
      }

      const outcome = await waitForDeploy(
        {
          now: Date.now,
          read: async (): Promise<RunnerDeploy | null> => {
            const rows = await runnerListDeploys(app.id, environmentId);

            if (deployId !== undefined) {
              return rows.find((row) => row.id === deployId) ?? null;
            }

            if (sha !== undefined) {
              return rows.find((row) => row.sha === sha) ?? null;
            }

            return rows.at(0) ?? null;
          },
          sleep: realSleep,
        },
        budgetSeconds * 1000
      );

      const where = env === null ? app.slug : `${app.slug}/${env.label}`;

      // The resume call is the same tool with the same arguments: an agent
      // that only read the text can re-arm without reconstructing anything.
      const resume = {
        arguments: {
          app: ref,
          deployId: deployId ?? null,
          environment: environment ?? null,
          maxWaitSeconds: budgetSeconds,
          sha: sha ?? null,
        },
        tool: "wait_for_deploy",
      };

      if (outcome._tag === "Settled") {
        return {
          structured: {
            appId: app.id,
            deploy: outcome.deploy,
            done: true,
            environment: env?.label ?? null,
            resume: null,
            slug: app.slug,
            status: outcome.deploy.status,
          },
          text: `${where}: deploy ${outcome.deploy.id} is ${outcome.deploy.status}${outcome.deploy.sha === null ? "" : ` at ${sha10(outcome.deploy.sha)}`}.`,
        };
      }

      if (outcome._tag === "Waiting") {
        return {
          structured: {
            appId: app.id,
            deploy: outcome.deploy,
            done: false,
            environment: env?.label ?? null,
            resume,
            slug: app.slug,
            status: outcome.deploy.status,
          },
          text: `${where}: deploy ${outcome.deploy.id} is still ${outcome.deploy.status} after ${budgetSeconds}s. Call wait_for_deploy again with the same arguments to keep waiting.`,
        };
      }

      return {
        structured: {
          appId: app.id,
          deploy: null,
          done: false,
          environment: env?.label ?? null,
          resume,
          slug: app.slug,
          status: null,
        },
        text: `${where}: ${wanted} has not appeared after ${budgetSeconds}s. The runner may not have queued it — call wait_for_deploy again, and check deploy_status.`,
      };
    },
  }),
];
