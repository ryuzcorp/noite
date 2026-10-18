import { requireAppRole } from "../../lib/collaborators";
import {
  MAX_SOURCE_BODY_BYTES,
  SOURCE_FORWARD_TIMEOUT_MS,
} from "../../lib/commit-source";
import { ensureDbPromise } from "../../lib/db";
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

/** The commit-shaped payload the browser posts to either source route (the
 * runner validates its contents). */
interface SourcePayload {
  branch?: string;
  deletes?: string[];
  files: SourceCommitFile[];
  fromSha?: string;
  message: string;
  moves?: SourceCommitMove[];
}

/** Both source routes' payload, shape-checked only: the runner is the
 * authority on paths, sizes and encodings. */
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

/** Both source routes' one gate and one forward: only the control UI's own
 * fetch calls them, so the cross-site gate, the session and the push role are
 * all checked before a byte of the body is read; then a bounded read and a
 * forward to the runner's own `source/{endpoint}`. A commit can be a folder of
 * uploads and a preview is the same payload, so neither fits the Void
 * JSON-action transport's body cap: they are their own routes, like the R2 upload. */
const forwardSourceBody = async (
  request: Request,
  env: KitEnv,
  params: Record<string, string | undefined> | undefined,
  endpoint: "commit" | "preview"
): Promise<Response> => {
  const appId = params?.appId?.trim() ?? "";
  if (!appId) {
    return new Response("app required", { status: 400 });
  }
  const refused = crossSiteRefusal(request, env);
  if (refused) {
    return refused;
  }
  await ensureDbPromise();
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
    return new Response(`invalid ${endpoint} body`, { status: 400 });
  }
  const body = runnerBody(
    payload,
    { name: user.name, userId: user.id },
    grant.role
  );
  const res = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/source/${endpoint}`,
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
  forwardSourceBody(request, env, params, "commit");

/** Browser deploy preview: the same body and gate as a commit, forwarded to
 * the runner's `source/preview`, which snapshots it onto the viewer's hidden
 * `refs/previews/<user>/<branch>` ref and deploys that (user, branch)
 * environment — creating it on first use — and answers the environment, the
 * commit and the deploy row. */
export const handleSourcePreview: RouteHandler = (request, env, params) =>
  forwardSourceBody(request, env, params, "preview");

/** Browser archive download: session + view role, and for a GET the cross-site
 * gate is `Sec-Fetch-Site` — browsers send `Origin` on GETs only when
 * cross-origin, but always send `Sec-Fetch-Site`. Streams the runner's tar
 * (and its 413 message) through untouched. */
export const handleSourceArchive: RouteHandler = async (
  request,
  env,
  params
) => {
  const appId = params?.appId?.trim() ?? "";
  if (!appId) {
    return new Response("app required", { status: 400 });
  }
  const site = request.headers.get("sec-fetch-site");
  if (
    (site !== null && site !== "same-origin") ||
    !originAllowed(request, env)
  ) {
    return new Response("origin not allowed", { status: 403 });
  }
  let ref: string;
  try {
    ref = new URL(request.url).searchParams.get("ref")?.trim() ?? "";
  } catch {
    return new Response("bad request", { status: 400 });
  }
  await ensureDbPromise();
  const session = await getSessionOrNull(request, env).catch(() => null);
  const user = session?.user;
  if (!user) {
    return new Response("Sign in required", { status: 401 });
  }
  const grant = await requireAppRole(appId, user.id, "view").catch(() => null);
  if (!grant) {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const query = ref === "" ? "" : `?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/source/archive${query}`,
    { headers: { authorization: `Bearer ${rc.token}` } }
  );
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/x-tar",
    },
    status: res.status,
  });
};
