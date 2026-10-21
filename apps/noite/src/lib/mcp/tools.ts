/* eslint-disable func-names -- Effect.gen uses anonymous generators */
/**
 * The MCP tool table (alpha.4 A4). Every tool runs as the account its API key
 * belongs to and passes the very same gates the UI's server actions do
 * (`roleFor` through `requireAppRole`), so an agent can do exactly what a
 * signed-in collaborator of that role can: reads are `view`, variables are
 * `admin`, and creating an app goes through the one `createAppForUser` path A5
 * uses. Tools call the wave 1 runner client functions; nothing here duplicates
 * another surface's logic.
 *
 * Each tool declares its arguments once, as an Effect schema: that is both the
 * parser the transport runs and the `inputSchema` it publishes, so an agent
 * never sees a contract the server does not enforce.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";

import type { CreateSourceInput } from "../apps/create-source";
import { TEMPLATES } from "../apps/templates";
import { UnauthorizedError } from "../auth";
import {
  listAppsForCollaborator,
  requireAppRole,
  requireAppRoleBySlug,
} from "../collaborators";
import { withDb } from "../db";
import type { AppRole } from "../roles";
import {
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
  runnerGitCommit,
  runnerGitLog,
  runnerGitRefs,
  runnerGitRemote,
  runnerListEnv,
  runnerRpc,
  runnerRpcBatch,
  runnerSetEnv,
  runnerSourceBlob,
  runnerSourceTree,
} from "../runner";
import type {
  GitCommitDetail,
  GitLog,
  GitRefs,
  RunnerApp,
  RunnerBlob,
  RunnerDeploy,
  RunnerEnvironment,
  RunnerErrorList,
  RunnerGitRemote,
  RunnerTree,
} from "../runner";
import { createAppForUser, slugError } from "../server/apps.server";
import { redactEnv } from "../server/env.server";
import { defineTool, McpToolError } from "./protocol";
import type { McpToolDefinition } from "./protocol";

/** What each role lets a tool do, in the words of the error a denied caller
 * reads. */
const NEEDS: Record<AppRole, string> = {
  admin: "administer",
  push: "push to",
  view: "view",
};

/** The app one tool call names, by slug (how agents see apps) or by id (what
 * `create_app` and `list_apps` return). Both lookups apply the same gate, and
 * a denial is the one message for "not found" and "no access" — the same
 * answer the UI gives, so an id is never an existence oracle. */
const requireApp = async (
  userId: string,
  ref: string,
  need: AppRole
): Promise<{ app: RunnerApp; role: AppRole }> => {
  try {
    return await requireAppRoleBySlug(ref, userId, need);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }
  }

  try {
    return await requireAppRole(ref, userId, need);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }

    throw new McpToolError(
      `No app "${ref}" this account can ${NEEDS[need]} (it may not exist, or you may not be a collaborator).`
    );
  }
};

/** The account's display name, for the one commit a create may author (a
 * squashed import). Absent accounts fall back to the platform default. */
const displayName = async (userId: string): Promise<string> => {
  const rows = await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;

      return yield* sql<{ name: string }>`
        SELECT name FROM "user" WHERE id = ${userId} LIMIT 1`;
    })
  );

  return rows[0]?.name?.trim() ?? "";
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

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  defineTool({
    description:
      "List the apps this account can see, with their slug, status and URL.",
    name: "list_apps",
    params: NoArgs,
    run: async ({ userId }) => {
      const apps = await listAppsForCollaborator(userId);

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
    run: async ({ userId }, { app: ref }) => {
      const { app, role } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { name, slug, source }) => {
      const normalized = slug.trim().toLowerCase();
      const problem = slugError(normalized);

      if (problem) {
        throw new McpToolError(problem, { invalid: true });
      }

      const app = await createAppForUser({
        account: { id: userId, name: await displayName(userId) },
        name: name?.trim() || normalized,
        slug: normalized,
        source: toCreateSource(source),
      });

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
      "An app's deploy state: status, whether it is live, and its recent deploys. Pass `environment` for one preview environment instead of production. Poll this after a push.",
    name: "deploy_status",
    params: appParams({ environment: Schema.optional(EnvironmentRef) }),
    run: async ({ userId }, { app: ref, environment }) => {
      const { app, role } = await requireApp(userId, ref, "view");

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
      const live = status === "running";

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
    run: async ({ userId }, { app: ref, deployId }) => {
      const { app } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, environment, limit }) => {
      const { app, role } = await requireApp(userId, ref, "view");

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
    run: async ({ userId }, { app: ref, environment, status }) => {
      const { app, role } = await requireApp(userId, ref, "view");

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
    run: async ({ userId }, { app: ref }) => {
      const { app } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, key, value }) => {
      const { app } = await requireApp(userId, ref, "admin");
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
    run: async ({ userId }, { app: ref, key }) => {
      const { app } = await requireApp(userId, ref, "admin");
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
    run: async ({ userId }, { app: ref }) => {
      const { app, role } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, branch }) => {
      const { app, role } = await requireApp(userId, ref, "push");
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
    run: async ({ userId }, { app: ref, environment }) => {
      const { app, role } = await requireApp(userId, ref, "admin");
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
    run: async ({ userId }, { app: ref, environment }) => {
      const { app, role } = await requireApp(userId, ref, "push");
      const env = await requireEnvironment(app, role, environment);
      const result = await runnerEnvironmentDeploy(app.id, env.id, role);

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
    run: async ({ userId }, { app: ref, environment, public: isPublic }) => {
      const { app, role } = await requireApp(userId, ref, "admin");
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
    run: async ({ userId }, { app: ref, environment }) => {
      const { app, role } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, environment, key, value }) => {
      const { app, role } = await requireApp(userId, ref, "push");
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
    run: async ({ userId }, { app: ref, environment, key }) => {
      const { app, role } = await requireApp(userId, ref, "push");
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
    run: async ({ userId }, { app: ref }) => {
      const { app } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, ref: revision }) => {
      const { app } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, path, ref: revision }) => {
      const { app } = await requireApp(userId, ref, "view");
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
    run: async ({ userId }, { app: ref, path, ref: revision, skip }) => {
      const { app } = await requireApp(userId, ref, "view");

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
    run: async ({ userId }, { app: ref, sha }) => {
      const { app } = await requireApp(userId, ref, "view");
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
];
