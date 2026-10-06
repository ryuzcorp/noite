import { authFromEnv, MissingAuthSecretError } from "../../lib/auth";
import { requireAppRole } from "../../lib/collaborators";
import { ensureDbPromise } from "../../lib/db";
import { MAX_BODY_BYTES, readBoundedText, tooLarge } from "../body";
import { runnerConfig } from "../config";
import type { RouteHandler } from "../config";

/** Machine ingest for tenant apps (LogSnag-style event API): Bearer
 * profile API key + push role on the app, then forward the JSON body to
 * the runner untouched so validation errors pass through with their
 * status codes. External callers use the control origin + `/api` path
 * (api.* routes to the runner, which knows no API keys). */
const INGEST_KINDS = new Set(["events", "identify", "insights"]);
export const forwardIngest: RouteHandler = async (request, env, params) => {
  const appId = params?.appId?.trim() ?? "";
  const kind = params?.kind?.trim() ?? "";
  if (!appId || !INGEST_KINDS.has(kind)) {
    return new Response(
      "app and endpoint (events|identify|insights) required",
      { status: 400 }
    );
  }
  const key = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer /u, "")
    .trim();
  if (!key) {
    return new Response("bearer token required", { status: 401 });
  }
  await ensureDbPromise();
  try {
    const auth = authFromEnv(
      env,
      env.BETTER_AUTH_URL ?? new URL(request.url).origin
    );
    const verified = await auth.api.verifyApiKey({
      body: { key, permissions: { events: ["push"] } },
    });
    if (!(verified.valid && verified.key?.referenceId)) {
      return new Response("invalid key", { status: 401 });
    }
    await requireAppRole(appId, verified.key.referenceId, "push");
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (body === null) {
    return tooLarge();
  }
  const upstream = await fetch(
    `${rc.runner}/v1/apps/${encodeURIComponent(appId)}/${kind}`,
    {
      body,
      headers: {
        authorization: `Bearer ${rc.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    }
  );
  return new Response(await upstream.text(), {
    headers: { "content-type": "application/json" },
    status: upstream.status,
  });
};
