/**
 * The pod's asset paths, decided by host before anything else runs: on the
 * app's Preview host they are the pod's (the document, its bundle, Nodepod's
 * runtime, the frame bundle's chunks); on every other host the pod's own
 * paths 404, and the control UI's own `/assets/*` falls through to the
 * platform exactly as before this gate existed.
 *
 * (What `src/http/routes/nodepod.ts` decided from the route table before the
 * Void routes slice; a middleware owns it now because `__sw__.js`-style
 * paths start with `_` and Void never scans those as routes.)
 */
import { defineMiddleware } from "void";

import { handlePreviewHostAsset } from "../http/routes/nodepod";
import {
  isControlDeniedAsset,
  PREVIEW_ASSET_PREFIX,
} from "../lib/preview-host";

export default defineMiddleware(async (c, next) => {
  const request = c.req.raw;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return next();
  }
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return next();
  }
  // The pod's own list plus the frame bundle's chunks (the control UI's own
  // assets on any other host, left to the platform below).
  if (!isControlDeniedAsset(path) && !path.startsWith(PREVIEW_ASSET_PREFIX)) {
    return next();
  }
  // SAFETY: the gate reads only the ASSETS binding off the Worker env.
  const answered = await handlePreviewHostAsset(request, c.env as KitEnv);
  if (answered) {
    return answered;
  }
  return next();
});
