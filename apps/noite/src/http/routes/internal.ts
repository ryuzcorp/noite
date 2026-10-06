import * as Schema from "effect/Schema";

import { authFromEnv, MissingAuthSecretError } from "../../lib/auth";
import { requireAppRoleBySlug } from "../../lib/collaborators";
import { ensureDbPromise } from "../../lib/db";
import { parseAppRole } from "../../lib/roles";
import {
  findRecoveryEmail,
  RECOVERY_CODE_TTL_SECONDS,
} from "../../lib/server/recovery.server";
import { countControlUsers } from "../../lib/server/telemetry.server";
import { MAX_BODY_BYTES, readBoundedText, tooLarge } from "../body";
import { runnerConfig, runnerTokenOk } from "../config";
import type { RouteHandler } from "../config";

/** Optional nudge path — prefer the runner's own webhook; this proxy is for
 * deploy.sh convenience. It adds no authority: the caller must already hold
 * the runner token, and only the body and content type are forwarded (never
 * the caller's cookies or other headers). */
export const handleWebhook: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (body === null) {
    return tooLarge();
  }
  return fetch(`${rc.runner}/webhook`, {
    body,
    headers: {
      authorization: `Bearer ${rc.token}`,
      "content-type":
        request.headers.get("content-type") ?? "application/octet-stream",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
};
const RecoveryBody = Schema.Struct({ email: Schema.optional(Schema.String) });

/** Operator escape hatch (`noite-runner recover`): mint a sign-in code for an
 * account without sending it anywhere, for an operator who lost the passkey
 * and has no email webhook. The caller must hold the runner token — whoever
 * can run a command in the container — and the code goes through the same
 * "Lost passkey?" sign-in as an emailed one: it expires, allows few attempts,
 * and lands on the account page to enrol a new passkey. */
export const handleRecovery: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  const text = await readBoundedText(request, MAX_BODY_BYTES);
  if (text === null) {
    return tooLarge();
  }
  let raw: unknown;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return Response.json({ error: "invalid json", ok: false }, { status: 400 });
  }
  const decoded = Schema.decodeUnknownResult(RecoveryBody)(raw);
  if (decoded._tag === "Failure") {
    return Response.json(
      { error: "email must be a string", ok: false },
      { status: 400 }
    );
  }
  await ensureDbPromise();
  const email = await findRecoveryEmail(decoded.success.email);
  if (!email) {
    return Response.json(
      {
        error: decoded.success.email
          ? `no active account for ${decoded.success.email}`
          : "no admin account exists yet: open the control UI and sign up first",
        ok: false,
      },
      { status: 404 }
    );
  }
  try {
    const auth = authFromEnv(env, new URL(request.url).origin);
    const code = await auth.api.createVerificationOTP({
      body: { email, type: "sign-in" },
    });
    return Response.json(
      { code, email, expiresInSeconds: RECOVERY_CODE_TTL_SECONDS, ok: true },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return Response.json(
        { error: error.message, ok: false },
        { status: 500 }
      );
    }
    throw error;
  }
};
const GitAuthBody = Schema.Struct({
  key: Schema.String,
  need: Schema.optional(Schema.String),
  slug: Schema.String,
});

/** Runner → UI: verify profile API key + collaborator role for a slug. */
export const handleGitAuth: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json", ok: false }, { status: 400 });
  }
  const decoded = Schema.decodeUnknownResult(GitAuthBody)(raw);
  if (decoded._tag === "Failure") {
    return Response.json(
      {
        error: "key, slug, and need (view|push|admin) required",
        ok: false,
      },
      { status: 400 }
    );
  }
  // decodeUnknownResult yields { _tag: "Success", success } — not `.value`.
  const key = decoded.success.key.trim();
  const slug = decoded.success.slug.trim();
  const need = parseAppRole(decoded.success.need?.trim() || "push");
  if (!(key && slug && need)) {
    return Response.json(
      {
        error: "key, slug, and need (view|push|admin) required",
        ok: false,
      },
      { status: 400 }
    );
  }
  await ensureDbPromise();
  try {
    const auth = authFromEnv(
      env,
      env.BETTER_AUTH_URL ?? new URL(request.url).origin
    );
    const verified = await auth.api.verifyApiKey({
      body: { key, permissions: { apps: ["manage"] } },
    });
    if (!(verified.valid && verified.key?.referenceId)) {
      return Response.json(
        { error: "invalid key", ok: false },
        { status: 401 }
      );
    }
    const userId = verified.key.referenceId;
    const access = await requireAppRoleBySlug(slug, userId, need);
    return Response.json({
      appId: access.app.id,
      ok: true,
      role: access.role,
      userId,
    });
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    return Response.json({ error: "forbidden", ok: false }, { status: 403 });
  }
};

/** Runner → UI: how many accounts exist on this instance. The runner buckets
 * the number into its heartbeat's `users` property (and treats an
 * unreachable control worker as `"unknown"`), so this answers the raw count
 * only — never an email, id or anything per-account. */
export const handleTelemetryFacts: RouteHandler = async (request, env) => {
  if (!runnerTokenOk(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const users = await countControlUsers();
    return Response.json(
      { users },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("[telemetry-facts]", error);
    return Response.json({ error: "user count unavailable" }, { status: 500 });
  }
};
