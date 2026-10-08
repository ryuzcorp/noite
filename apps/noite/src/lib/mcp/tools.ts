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

/** The public URL of an app: the runner derives it from the git base's scheme
 * and port plus the app's own subdomain (`app_url` in the runner), so the
 * remote the API hands over carries both. */
const appUrl = (remoteUrl: string, subdomain: string): string => {
  const parsed = new URL(remoteUrl);
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `${parsed.protocol}//${subdomain}${port}`;
};

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
    return { kind: "git", ref: source.ref, url: source.url };
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
      "An app's deploy state: status, whether it is live, and its recent deploys. Poll this after a push.",
    name: "deploy_status",
    params: AppParams,
    run: async ({ userId }, { app: ref }) => {
      const { app } = await requireApp(userId, ref, "view");
      const deploys = await runnerRpc<RunnerDeploy[]>("deploys.list", {
        id: app.id,
      });
      const recent = deploys.slice(0, 5);
      const latest = recent.at(0) ?? null;
      const live = app.status === "running";
      return {
        structured: {
          appId: app.id,
          deploy: latest,
          desiredState: app.desiredState,
          lastDeploySha: app.lastDeploySha,
          live,
          name: app.name,
          recent,
          slug: app.slug,
          status: app.status,
        },
        text: [
          `${app.slug}: ${app.status}${live ? " (live)" : ""}, desired ${app.desiredState}.`,
          app.lastError === null ? "" : `last error: ${app.lastError}`,
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
      "The app's recent runtime log lines (the tail of the merged build and runtime log).",
    name: "app_logs",
    params: appParams({
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
    run: async ({ userId }, { app: ref, limit }) => {
      const { app } = await requireApp(userId, ref, "view");
      const all = await runnerRpc<string[]>("logs.get", { id: app.id });
      const lines = all.slice(-(limit ?? 200));
      return {
        structured: { appId: app.id, lines, slug: app.slug, total: all.length },
        text:
          lines.length === 0 ? `${app.slug}: no log lines.` : lines.join("\n"),
      };
    },
  }),
  defineTool({
    description:
      "The app's error issues grouped by fingerprint, with 24-hour counts.",
    name: "app_errors",
    params: appParams({
      status: Schema.optional(
        Schema.Literals(["open", "resolved", "ignored"]).annotate({
          description: "Which issues to list (default open).",
        })
      ),
    }),
    run: async ({ userId }, { app: ref, status }) => {
      const { app } = await requireApp(userId, ref, "view");
      const list = await runnerRpc<RunnerErrorList>("errors.list", {
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
      const counts = `${list.counts.open} open, ${list.counts.resolved} resolved, ${list.counts.ignored} ignored`;
      return {
        structured: {
          appId: app.id,
          counts: list.counts,
          issues,
          slug: app.slug,
        },
        text:
          issues.length === 0
            ? `${app.slug}: no ${status ?? "open"} errors (${counts}).`
            : [
                `${issues.length} ${status ?? "open"} error issue${issues.length === 1 ? "" : "s"} in ${app.slug} (${counts}):`,
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
