//! The pod host document and its headers, as the app serves them.
//!
//! They are strings here, not files under `public/`, because the frame is
//! exactly the kind of response that must not be left to the deployment's
//! static-asset rules: the control UI (cross-origin isolated) embeds this
//! document, so it has to carry `Cross-Origin-Resource-Policy: cross-origin`
//! and, at the same time, `Cross-Origin-Embedder-Policy` +
//! `Cross-Origin-Opener-Policy` for the frame's own worker cluster to keep
//! `SharedArrayBuffer`. A `public/_headers` rule cannot express that on one
//! path (`/*`'s `CORP: same-origin` is applied by celld to every asset, and a
//! second value makes a browser refuse the frame), and the deployed edge only
//! fixes it up on the preview host. So `src/http/routes/nodepod.ts` answers the
//! document — on the pod host only — and the dev server mirrors it, with
//! `POD_HOST_HEADERS` either way.
//!
//! The document is the whole workspace: it boots Nodepod, the checkout and the
//! shell *on the app's pod host origin*, and the control page
//! talks to it over `src/lib/source/pod-protocol.ts`. App-controlled code —
//! install scripts, builds, terminal commands — therefore runs
//! in its own agent cluster, never the control UI's.

/** The isolation headers the frame's response needs, and why: `cross-origin`
 * so the control UI may embed it, COEP/COOP so the frame — and the process
 * workers it creates — get `SharedArrayBuffer`. No Content-Security-Policy: a
 * worker built from a blob inherits the frame's, and the pod's processes need
 * the network (the package registry) and `eval`. The boundary is the origin. */
export const POD_HOST_HEADERS = {
  "Cache-Control": "no-store",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;

/** The frame entry in the Vite client build: module id
 * `src/pod-host/main.ts`, built to `/noite-pod-host.js`. Fixed in dev so the
 * document points straight at Vite's module graph instead of a bundle that
 * only exists after a build. */
export const POD_HOST_DEV_JS = "/src/pod-host/main.ts";

/** The frame document, pointing at `scriptSrc` (dev: `POD_HOST_DEV_JS`, the
 * module graph; prod: `/noite-pod-host.js`, the built bundle). Nothing else is
 * in it: the control page passes the app, branch and handshake nonce in the
 * query string, and the frame's own module decides everything else over the
 * protocol. */
export const podHostHtml = (scriptSrc: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Noite workspace host</title>
  </head>
  <body>
    <script src="${scriptSrc}" type="module"></script>
  </body>
</html>
`;
