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
import { getSessionOrNull } from "../../lib/server/session.server";
import { readBoundedText, tooLarge } from "../body";
import { runnerConfig } from "../config";
import type { RouteHandler } from "../config";
import { originAllowed } from "../origin";

/** The commit-shaped payload the browser posts (the runner validates its
 * contents). */
interface SourcePayload {
  branch?: string;
  deletes?: string[];
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

/** The cross-site gate, checked before anything else is read: a JSON content
 * type (a cross-site caller must then pass a CORS preflight this route never
 * grants) and an `Origin` that is this site (present, since a browser sends it
 * on POST). A same-site tenant subdomain is SameSite-Lax, not exempt, and must
 * not be able to post a commit as a signed-in victim. */
const crossSiteRefusal = (request: Request, env: KitEnv): Response | null => {
  const [mediaType = ""] = (request.headers.get("content-type") ?? "").split(
    ";"
  );

  if (mediaType.trim().toLowerCase() !== "application/json") {
    return new Response("content-type must be application/json", {
      status: 415,
    });
  }

  if (!request.headers.get("origin") || !originAllowed(request, env)) {
    return new Response("origin not allowed", { status: 403 });
  }

  return null;
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

  if (payload.deletes !== undefined && payload.deletes.length > 0) {
    body.deletes = payload.deletes;
  }

  if (payload.moves !== undefined && payload.moves.length > 0) {
    body.moves = payload.moves;
  }

  return body;
};

/** The source commit's one gate and one forward: only the control UI's own
 * fetch calls it, so the cross-site gate, the session and the push role are
 * all checked before a byte of the body is read; then a bounded read and a
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

  const refused = crossSiteRefusal(request, env);

  if (refused) {
    return refused;
  }

  await ensureDb();
  const session = await getSessionOrNull(request, env).catch(() => null);
  const user = session?.user;

  if (!user) {
    return new Response("Sign in required", { status: 401 });
  }

  const grant = await requireAppRole(appId, user.id, "push").catch(() => null);

  if (!grant) {
    return new Response("forbidden", { status: 403 });
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

  const body = runnerBody(
    payload,
    { name: user.name, userId: user.id },
    grant.role
  );

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
