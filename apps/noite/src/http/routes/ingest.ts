import { ensureDb } from "../../lib/db";
import { keyAppVerdict } from "../../lib/server/key-access.server";
import { authenticateKey } from "../../lib/server/key-auth.server";
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

  await ensureDb();

  // The same one authentication `/mcp` and git use: scope (`events.push`),
  // then the owner's ban, then the key's expiry. A banned owner's key must
  // stop ingesting even if the ban's revocation missed it.
  const auth = await authenticateKey(request, env, key, {
    events: ["push"],
  });

  if (auth._tag === "Misconfigured") {
    return new Response(auth.message, { status: 500 });
  }

  if (auth._tag !== "Authed") {
    return new Response(
      auth._tag === "Expired" ? "API key expired" : "invalid key",
      { status: 401 }
    );
  }

  // Push role on the app, through the key's app set and role ceiling: a key
  // scoped to another app cannot write this app's events.
  const verdict = await keyAppVerdict(auth.principal, { id: appId }, "push");

  if (verdict._tag !== "Granted") {
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
