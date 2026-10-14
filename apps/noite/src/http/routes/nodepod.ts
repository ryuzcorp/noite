import { POD_HOST_HEADERS, podHostHtml } from "../../lib/pod-host-document";
import {
  isControlDeniedAsset,
  isPreviewHost,
  POD_HOST_HTML_PATH,
  POD_HOST_JS_PATH,
} from "../../lib/preview-host";
import type { RouteHandler } from "../config";

/** The Assets binding the deployment carries (celld's `env.ASSETS`). */
interface AssetsBinding {
  fetch: (request: Request) => Promise<Response>;
}

const hasAssets = (env: KitEnv): env is KitEnv & { ASSETS: AssetsBinding } =>
  "ASSETS" in env &&
  typeof env.ASSETS === "object" &&
  env.ASSETS !== null &&
  "fetch" in env.ASSETS &&
  typeof env.ASSETS.fetch === "function";

/** Every path that belongs to a pod — the host document, its bundle, the
 * process-worker bundle and the service worker — is answered on the app's
 * pod host. On any other host, the control UI's own included, they answer
 * 404 (`isControlDeniedAsset`): a worker inherits its creator document's
 * origin, so a path that let a guest app create one on the control origin would
 * run its code inside the control UI's agent cluster, cookies and storage.
 *
 * The document is the app's own response — it needs
 * `Cross-Origin-Resource-Policy: cross-origin` *and* COEP/COOP at once, which
 * the deployment's `/*` static-asset rule cannot express (see
 * `lib/pod-host-document.ts`) — while the bundle and Nodepod's runtime assets
 * are ordinary static files, served from the deployment's own assets. */
export const handlePreviewHostAsset: RouteHandler = async (request, env) => {
  const path = new URL(request.url).pathname;
  if (!isPreviewHost(request.headers.get("host"))) {
    return isControlDeniedAsset(path)
      ? new Response("Not Found", { status: 404 })
      : undefined;
  }
  if (path === POD_HOST_HTML_PATH) {
    return new Response(podHostHtml(POD_HOST_JS_PATH), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...POD_HOST_HEADERS,
      },
      status: 200,
    });
  }
  if (!hasAssets(env)) {
    return new Response("Not Found", { status: 404 });
  }
  return await env.ASSETS.fetch(request);
};
