import { requireAppRole } from "../../lib/collaborators";
import { ensureDbPromise } from "../../lib/db";
import { runnerConfig } from "../config";
import type { RouteHandler } from "../config";
import { routeUserId } from "../session";

/** Content types a browser renders as a document: served inline like the
 * rest, but under a sandbox, so a direct visit to the proxy URL cannot run
 * the script an uploaded object might carry. */
const SANDBOXED_R2_TYPES = {
  "application/xhtml+xml": true,
  "application/xml": true,
  "image/svg+xml": true,
  "text/html": true,
  "text/xml": true,
} satisfies Record<string, true>;

/** Path params + key query for an R2 object route (undefined when bad). */
const r2ObjectTarget = (
  request: Request,
  params?: Record<string, string | undefined>
): { appId: string; bucket: string; key: string } | undefined => {
  const appId = params?.appId?.trim() ?? "";
  const bucket = params?.bucket?.trim() ?? "";
  let key: string;
  try {
    key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  } catch {
    return undefined;
  }
  if (!(appId && bucket && key)) {
    return undefined;
  }
  return { appId, bucket, key };
};

/** Fetch one raw R2 object from the runner and re-serve it to the browser
 * with the object's own media type (the UI renders images through this URL
 * and offers it as the download link), unreachable-by-script headers for the
 * dangerous types, and no sniffing. The body streams through, so a large
 * download shows progress instead of hanging into the platform deadline. */
const proxyR2Object = async (
  runner: string,
  token: string,
  appId: string,
  bucket: string,
  key: string
): Promise<Response> => {
  const upstream =
    `${runner}/v1/apps/${encodeURIComponent(appId)}` +
    `/storage/r2/${encodeURIComponent(bucket)}/raw?key=${encodeURIComponent(key)}`;
  const res = await fetch(upstream, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return new Response(text, { status: res.status });
  }
  const filename = key.split("/").pop() ?? key;
  const type = (res.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const headers = new Headers();
  headers.set("content-type", type || "application/octet-stream");
  headers.set(
    "content-disposition",
    `inline; filename="${filename.replaceAll('"', "_")}"`
  );
  headers.set("x-content-type-options", "nosniff");
  if (Object.hasOwn(SANDBOXED_R2_TYPES, type)) {
    headers.set("content-security-policy", "sandbox");
  }
  return new Response(res.body, { headers, status: res.status });
};
/** Browser upload for one R2 object: session + push gate, then stream the
 * body to the runner (which spools it and calls `celld r2 put`, so the
 * stored record is what a Worker's `env.BUCKET.put()` writes). Nothing
 * buffers the file — the browser's body is handed to fetch as it arrives. */
export const handleR2Upload: RouteHandler = async (request, env, params) => {
  const target = r2ObjectTarget(request, params);
  if (!target) {
    return new Response("app, bucket, and key required", { status: 400 });
  }
  await ensureDbPromise();
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(target.appId, userId, "push");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  const upstream =
    `${rc.runner}/v1/apps/${encodeURIComponent(target.appId)}` +
    `/storage/r2/${encodeURIComponent(target.bucket)}/object` +
    `?key=${encodeURIComponent(target.key)}`;
  // Node/undici require `duplex: "half"` for a streamed request body; workerd
  // takes the stream either way and ignores the member (RequestInit has no
  // field for it, hence the widened local).
  const init: RequestInit & { duplex?: "half" } = {
    body: request.body,
    duplex: "half",
    headers: {
      authorization: `Bearer ${rc.token}`,
      "content-type":
        request.headers.get("content-type") ?? "application/octet-stream",
    },
    method: "PUT",
  };
  const res = await fetch(upstream, init);
  return new Response(await res.text(), {
    headers: { "content-type": "application/json" },
    status: res.status,
  });
};
/** Browser download for one R2 object: session + view-role gate, then proxy
 * the runner's raw bytes (the browser never sees RUNNER_TOKEN). */
export const handleR2Raw: RouteHandler = async (request, env, params) => {
  const target = r2ObjectTarget(request, params);
  if (!target) {
    return new Response("app, bucket, and key required", { status: 400 });
  }
  await ensureDbPromise();
  const userId = await routeUserId(request, env);
  if (!userId) {
    return new Response("Sign in required", { status: 401 });
  }
  try {
    await requireAppRole(target.appId, userId, "view");
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const rc = runnerConfig(env);
  if (!rc) {
    return new Response("RUNNER_TOKEN is not configured", { status: 500 });
  }
  return proxyR2Object(
    rc.runner,
    rc.token,
    target.appId,
    target.bucket,
    target.key
  );
};
