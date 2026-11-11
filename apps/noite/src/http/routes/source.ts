import { requireAppRole } from "../../lib/collaborators";
import {
  MAX_SOURCE_BODY_BYTES,
  SOURCE_FORWARD_TIMEOUT_MS,
} from "../../lib/commit-source";
import { ensureDb } from "../../lib/db";
import type {
  SourceCommitBody,
  SourceCommitFile,
  SourceCommitMove,
} from "../../lib/runner";
import { keyAppVerdict } from "../../lib/server/key-access.server";
import { keyActor } from "../../lib/server/key-attribution.server";
import { authenticateKey, bearerKey } from "../../lib/server/key-auth.server";
import { getSessionOrNull } from "../../lib/server/session.server";
import { readBoundedText, tooLarge } from "../body";
import { runnerConfig } from "../config";
import type { RouteHandler } from "../config";
import { originAllowed } from "../origin";

/** The commit-shaped payload a caller posts (the runner validates its
 * contents). `expectedTip` is an agent's compare-and-set precondition; the
 * control UI leaves it out. */
interface SourcePayload {
  branch?: string;
  deletes?: string[];
  expectedTip?: string;
  files: SourceCommitFile[];
  fromSha?: string;
  message: string;
  moves?: SourceCommitMove[];
}

/** The commit payload, shape-checked only: the runner is the authority on
 * paths, sizes and encodings. */
const isSourcePayload = (value: unknown): value is SourcePayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // SAFETY: `value` is a non-null object; both fields are read as `unknown`
  // and checked below before the guard says anything about them.
  const { files, message } = value as { files?: unknown; message?: unknown };

  return typeof message === "string" && Array.isArray(files);
};

/** The JSON content type, checked before the body is read: a cross-site caller
 * must then pass a CORS preflight this route never grants. Both callers send
 * it — the control UI's own fetch and an agent's HTTP client. */
const contentTypeRefusal = (request: Request): Response | null => {
  const [mediaType = ""] = (request.headers.get("content-type") ?? "").split(
    ";"
  );

  return mediaType.trim().toLowerCase() === "application/json"
    ? null
    : new Response("content-type must be application/json", { status: 415 });
};

/** The cookie caller's cross-site gate: `Origin` must be present and this site.
 * A browser sends it on every POST, and a same-site tenant subdomain is
 * SameSite-Lax, not exempt, so it must not be able to post a commit as a
 * signed-in victim. A bearer key is not ambient, so the key path only has to
 * refuse an `Origin` that belongs to somebody else. */
const originRefusal = (request: Request, env: KitEnv): Response | null =>
  request.headers.get("origin") === null || !originAllowed(request, env)
    ? new Response("origin not allowed", { status: 403 })
    : null;

/** What one source write runs as, with the app gate already applied: the
 * commit actor the runner records and the role it trusts for policy. */
interface SourceCaller {
  actor: SourceCommitBody["actor"];
  role: string;
}

/** Resolve one source write's caller, or the refusal to answer with.
 *
 * A session cookie is the control UI's own fetch (unchanged): the cookie is
 * ambient, so the cross-site gate above runs first. `Authorization: Bearer
 * noite_…` is an agent or the CLI, authenticated by the very function `/mcp`
 * uses (`authenticateKey`) with the same `apps: manage` permission, then gated
 * on this app by the one key-enforcement function (`keyAppVerdict`): a key
 * limited to other apps, capped below `push`, expired or owner-banned cannot
 * commit either. The forwarded role is the key's *effective* one, never the
 * owner's un-narrowed role. */
const sourceCaller = async (
  request: Request,
  env: KitEnv,
  appId: string
): Promise<SourceCaller | Response> => {
  const key = bearerKey(request);

  if (key === null) {
    const refused = originRefusal(request, env);

    if (refused) {
      return refused;
    }

    await ensureDb();
    const session = await getSessionOrNull(request, env).catch(() => null);
    const user = session?.user;

    if (!user) {
      return new Response("Sign in required", { status: 401 });
    }

    const grant = await requireAppRole(appId, user.id, "push").catch(
      () => null
    );

    if (!grant) {
      return new Response("forbidden", { status: 403 });
    }

    return { actor: { name: user.name, userId: user.id }, role: grant.role };
  }

  // A bearer credential carries no ambient authority: only an `Origin` that is
  // somebody else's is refused (a browser replay would still be cross-site).
  if (!originAllowed(request, env)) {
    return new Response("origin not allowed", { status: 403 });
  }

  const auth = await authenticateKey(request, env, key, { apps: ["manage"] });

  if (auth._tag === "Misconfigured") {
    return new Response(auth.message, { status: 500 });
  }

  if (auth._tag !== "Authed") {
    // One body for every refusal, exactly as `/mcp` answers: a key without the
    // permission, an unknown key and an expired one read the same.
    return new Response("missing or invalid API key", {
      headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
      status: 401,
    });
  }

  const verdict = await keyAppVerdict(auth.principal, { id: appId }, "push");

  if (verdict._tag !== "Granted") {
    return new Response("forbidden", { status: 403 });
  }

  return { actor: await keyActor(auth.principal), role: verdict.role };
};

/** The runner's body: identity and role come from the session, never the
 * browser; empty optional lists are omitted. */
const runnerBody = (
  payload: SourcePayload,
  actor: SourceCommitBody["actor"],
  role: string
): SourceCommitBody => {
  const body: SourceCommitBody = {
    actor,
    files: payload.files,
    message: payload.message,
    role,
  };

  if (payload.branch !== undefined) {
    body.branch = payload.branch;
  }

  if (payload.fromSha !== undefined) {
    body.fromSha = payload.fromSha;
  }

  if (payload.expectedTip !== undefined) {
    body.expectedTip = payload.expectedTip;
  }

  if (payload.deletes !== undefined && payload.deletes.length > 0) {
    body.deletes = payload.deletes;
  }

  if (payload.moves !== undefined && payload.moves.length > 0) {
    body.moves = payload.moves;
  }

  return body;
};

/** The source commit's one gate and one forward: the credential (the control
 * UI's session cookie, or an agent's API key) and the app's push gate are
 * resolved before a byte of the body is read; then a bounded read and a
 * forward to the runner's own `source/commit`. A commit can be a folder of
 * uploads, so it does not fit the Void JSON-action transport's body cap: it is
 * its own route, like the R2 upload. */
const forwardSourceBody = async (
  request: Request,
  env: KitEnv,
  params: Record<string, string | undefined> | undefined
): Promise<Response> => {
  const appId = params?.appId?.trim() ?? "";

  if (!appId) {
    return new Response("app required", { status: 400 });
  }

  const notJson = contentTypeRefusal(request);

  if (notJson) {
    return notJson;
  }

  const caller = await sourceCaller(request, env, appId);

  if (caller instanceof Response) {
    return caller;
  }

  const rc = runnerConfig(env);

  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }

  const raw = await readBoundedText(request, MAX_SOURCE_BODY_BYTES);

  if (raw === null) {
    return tooLarge();
  }

  let payload: unknown;

  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  if (!isSourcePayload(payload)) {
    return new Response("invalid commit body", { status: 400 });
  }

  const body = runnerBody(payload, caller.actor, caller.role);

  const res = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/source/commit`,
    {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${rc.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(SOURCE_FORWARD_TIMEOUT_MS),
    }
  );

  return new Response(await res.text(), {
    headers: { "content-type": "application/json" },
    status: res.status,
  });
};

export const handleSourceCommit: RouteHandler = (request, env, params) =>
  forwardSourceBody(request, env, params);
