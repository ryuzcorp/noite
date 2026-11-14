import * as Schema from "effect/Schema";

import { authFromEnv, MissingAuthSecretError } from "../../lib/auth";
import { ensureDb } from "../../lib/db";
import { errorLogText } from "../../lib/errors";
import type { KeyPrincipal } from "../../lib/key-principal";
import { parseAppRole } from "../../lib/roles";
import {
  isAppLimitReached,
  isSlugTaken,
  runnerFailureMessage,
  runnerFailureOf,
} from "../../lib/runner";
import { createAppForUser, slugError } from "../../lib/server/apps.server";
import { keyAppVerdict } from "../../lib/server/key-access.server";
import { authenticateKey } from "../../lib/server/key-auth.server";
import {
  findRecoveryEmail,
  RECOVERY_CODE_TTL_SECONDS,
} from "../../lib/server/recovery.server";
import { countControlUsers } from "../../lib/server/telemetry.server";
import { MAX_BODY_BYTES, readBoundedText, tooLarge } from "../body";
import { runnerConfig, runnerTokenOk } from "../config";
import type { RouteHandler } from "../config";
import { routeFailure } from "../route-failure";

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

  let email: Awaited<ReturnType<typeof findRecoveryEmail>>;

  try {
    await ensureDb();
    email = await findRecoveryEmail(decoded.success.email);
  } catch (error) {
    return routeFailure("[recovery]", error);
  }

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

    // The one-time code is a bound parameter of the write: a wrapped query
    // failure must not reach Void's console.error, and the caller gets a
    // generic answer.
    console.error("[recovery] code creation failed", errorLogText(error));

    return Response.json(
      { error: "recovery unavailable", ok: false },
      { status: 500 }
    );
  }
};

const GitAuthBody = Schema.Struct({
  key: Schema.String,
  need: Schema.optional(Schema.String),
  slug: Schema.String,
});

/** A5 push-to-create: the runner asks with `need=create` on a receive-pack for
 * a slug nobody owns yet. The verified key's account gets the app through the
 * very same create path the create action uses (name = slug, blank source,
 * admin grant), so the pusher becomes its admin.
 *
 * An invalid or reserved slug is a plain 404 — the same answer as any unknown
 * repo — and the account's app limit is a 403 whose text the pusher reads as a
 * `remote:` line. A slug taken between our read and the insert (two first
 * pushes at once) re-reads the app: the pusher may push if it turned out to be
 * theirs, and sees the 404 otherwise. */
const gitAuthCreate = async (
  principal: KeyPrincipal,
  slug: string
): Promise<Response> => {
  const { userId } = principal;

  const notFound = Response.json(
    { error: "repository not found", ok: false },
    { status: 404 }
  );

  if (slugError(slug)) {
    return notFound;
  }

  try {
    const app = await createAppForUser({
      account: { id: userId, name: slug },
      name: slug,
      slug,
    });

    // The app now exists (created, or adopted by the retry recovery): answer
    // with the role the key gate resolves on the resolved id, never a
    // hard-coded admin. An adopted row the account does not administer is
    // refused like any other app it cannot push to.
    const verdict = await keyAppVerdict(principal, { id: app.id }, "admin");

    if (verdict._tag !== "Granted") {
      return notFound;
    }

    return Response.json({
      appId: verdict.app.id,
      ok: true,
      role: verdict.role,
      userId,
    });
  } catch (error) {
    const failure = runnerFailureOf(error);

    if (isSlugTaken(failure)) {
      // The slug is someone's app: the same key gate decides, so a capped or
      // app-restricted key never learns more than the ordinary path gives it.
      const verdict = await keyAppVerdict(principal, { slug }, "admin");

      if (verdict._tag !== "Granted") {
        return notFound;
      }

      return Response.json({
        appId: verdict.app.id,
        ok: true,
        role: verdict.role,
        userId,
      });
    }

    if (isAppLimitReached(failure)) {
      // The runner's own text is the sentence the pusher reads, never a
      // status code.
      return Response.json(
        { error: runnerFailureMessage(failure), ok: false },
        { status: 403 }
      );
    }

    throw error;
  }
};

/** The account behind a git credential, or the response the caller gets.
 * The lookup is a database read: its wrapped failure is the statement and the
 * bound key material, so it reaches neither the client nor the log. */
const gitAuthPrincipal = async (
  request: Request,
  env: KitEnv,
  key: string
): Promise<{ principal: KeyPrincipal } | { response: Response }> => {
  let auth: Awaited<ReturnType<typeof authenticateKey>>;

  try {
    auth = await authenticateKey(request, env, key, { apps: ["manage"] });
  } catch (error) {
    console.error("[git-auth] key lookup failed", errorLogText(error));

    return {
      response: Response.json(
        { error: "forbidden", ok: false },
        { status: 500 }
      ),
    };
  }

  if (auth._tag === "Misconfigured") {
    return { response: new Response(auth.message, { status: 500 }) };
  }

  if (auth._tag !== "Authed") {
    return {
      response: Response.json(
        {
          error: auth._tag === "Expired" ? "API key expired" : "invalid key",
          ok: false,
        },
        { status: 401 }
      ),
    };
  }

  return { principal: auth.principal };
};

/** The key's role on the named app, or the response the caller gets. Every
 * refusal answers the same 403: the app set, the role ceiling and "not a
 * collaborator" must not be told apart (or a key could probe which apps
 * exist). A failed read is logged through its cause chain and answers a flat
 * 500. */
const gitAppAccess = async (
  principal: KeyPrincipal,
  slug: string,
  need: "admin" | "push" | "view"
): Promise<
  | { response: Response }
  | { verdict: Awaited<ReturnType<typeof keyAppVerdict>> & { _tag: "Granted" } }
> => {
  let verdict: Awaited<ReturnType<typeof keyAppVerdict>>;

  try {
    verdict = await keyAppVerdict(principal, { slug }, need);
  } catch (error) {
    console.error("[git-auth] key verdict failed", errorLogText(error));

    return {
      response: Response.json(
        { error: "forbidden", ok: false },
        { status: 500 }
      ),
    };
  }

  if (verdict._tag !== "Granted") {
    return {
      response: Response.json(
        { error: "forbidden", ok: false },
        { status: 403 }
      ),
    };
  }

  return { verdict };
};

/** Runner → UI: verify profile API key + collaborator role for a slug, or
 * create the app when the push names a slug nobody owns yet (A5). */
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
        error: "key, slug, and need (view|push|admin|create) required",
        ok: false,
      },
      { status: 400 }
    );
  }

  // decodeUnknownResult yields { _tag: "Success", success } — not `.value`.
  const key = decoded.success.key.trim();
  const slug = decoded.success.slug.trim();
  const wanted = decoded.success.need?.trim() || "push";
  const need = wanted === "create" ? null : parseAppRole(wanted);

  if (!(key && slug && (need || wanted === "create"))) {
    return Response.json(
      {
        error: "key, slug, and need (view|push|admin|create) required",
        ok: false,
      },
      { status: 400 }
    );
  }

  // One authentication for every key surface (lib/server/key-auth.server):
  // the scope, the owner's ban and the key's expiry are decided once, here,
  // for git exactly as for `/mcp` and ingest.
  let authenticated: Awaited<ReturnType<typeof gitAuthPrincipal>>;

  try {
    await ensureDb();
    authenticated = await gitAuthPrincipal(request, env, key);
  } catch (error) {
    return routeFailure("[git-auth]", error);
  }

  if ("response" in authenticated) {
    return authenticated.response;
  }

  const { principal } = authenticated;

  if (wanted === "create") {
    // A key limited to apps cannot grow its own set: the app the push would
    // create is not one of the key's apps, so claiming it here would fail on
    // the very next request.
    if (principal.scope.appIds !== null) {
      return Response.json(
        { error: "This API key is limited to specific apps", ok: false },
        { status: 403 }
      );
    }

    // Creating an app makes the caller its admin, so only a key that may
    // administer may create one: a capped key must not answer `admin` here.
    if (principal.scope.roleCeiling !== "admin") {
      return Response.json(
        {
          error: "This API key's role ceiling cannot create apps",
          ok: false,
        },
        { status: 403 }
      );
    }

    try {
      return await gitAuthCreate(principal, slug);
    } catch (error) {
      // The create can fail after a database read (the adoption lookup), whose
      // wrapped error is the SQL plus its parameters: log the cause chain only.
      console.error("[git-auth]", errorLogText(error));

      return Response.json({ error: "forbidden", ok: false }, { status: 403 });
    }
  }

  // The create branch returned above, so `need` is the parsed role here.
  if (!need) {
    return Response.json(
      { error: "need must be view, push, admin or create", ok: false },
      { status: 400 }
    );
  }

  const access = await gitAppAccess(principal, slug, need);

  if ("response" in access) {
    return access.response;
  }

  const { verdict } = access;

  return Response.json({
    appId: verdict.app.id,
    ok: true,
    role: verdict.role,
    userId: principal.userId,
  });
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
    console.error("[telemetry-facts]", errorLogText(error));

    return Response.json({ error: "user count unavailable" }, { status: 500 });
  }
};
