// Explicit `.ts`: `vite.config.ts` imports this module, and Vite's native
// config loader (the planned default) cannot resolve an extensionless import.
import { isLocalhostDomain } from "./local-host.ts";

/** Every app's Preview origin label. Must match `PREVIEW_LABEL` in
 * `apps/runner/src/host/edge.rs` (and the site `apps/runner/src/host/caddy.rs`
 * emits). Stable on purpose: on-demand TLS then issues one certificate per app,
 * where Nodepod's per-boot random instance id would re-issue on every open and
 * could drain the CA's issuance limit. The pod host document, the pod's workers
 * and its preview service worker all live on this one origin per app. */
const PREVIEW_LABEL = "app-0";

/** The app's Preview host: `app-0.preview.<slug>.<BASE_DOMAIN>` (dev:
 * `app-0.preview.<slug>.noite.localhost`). One extra label under the instance
 * wildcard, so it needs no new DNS and the same on-demand TLS, and it can never
 * be a tenant host (a tenant slug carries no dot). */
export const previewHost = (slug: string, baseDomain: string): string =>
  `${PREVIEW_LABEL}.preview.${slug}.${baseDomain}`;

/** The app's Preview origin: where the pod host document is embedded from and
 * where every message the workspace protocol carries must come from. It is a
 * literal origin, with no `{instanceId}`/`{port}` placeholders — the pod boots
 * with path URLs on this origin (`previewOrigin: false`), so nothing needs to
 * interpolate an instance id anywhere. Dev keeps the control's port:
 * `*.localhost` is browser-reserved, so it needs no hosts entry and no wildcard
 * DNS. */
export const previewOrigin = (
  slug: string,
  baseDomain: string,
  port = ""
): string => {
  const scheme = isLocalhostDomain(baseDomain) ? "http" : "https";
  const devPort = port === "" ? "" : `:${port}`;

  return `${scheme}://${previewHost(slug, baseDomain)}${devPort}`;
};

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The base the app's Preview host hangs under for a page on `pageHost`: that
 * host itself when it is a DNS `CONTROL_EXTRA_HOSTS` entry (a LAN name such as
 * `noite.local` served over https by a local proxy, a Coolify domain), else
 * `BASE_DOMAIN`. The preview origin then stays on the page's own network and
 * scheme, and same-site with it. Mirrors `Config::tenant_bases` in
 * `apps/runner/src/config.rs`, which renders the edge's preview site for every
 * such base; bare IPs and entries with a port or path are never bases. */
export const previewBase = (
  pageHost: string,
  baseDomain: string,
  extraHosts = ""
): string => {
  const host = (pageHost.split(":")[0] ?? "").toLowerCase();

  const match = extraHosts
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replaceAll(/^\.+|\.+$/gu, "")
        .toLowerCase()
    )
    .find(
      (entry) =>
        entry === host &&
        !entry.includes(":") &&
        !entry.includes("/") &&
        !IPV4.test(entry)
    );

  return match ?? baseDomain;
};

/** The pod host document and its bundle on the app's Preview host. That
 * document *is* the workspace: it boots Nodepod, the checkout, the preview and
 * the shell, and it is the only thing that may create the workspace's process
 * workers. A worker takes the origin of the document that creates it, so
 * hosting the pod here is what keeps app-controlled code (install scripts, the
 * dev script, builds, terminal commands) out of the control UI's agent cluster
 * — and with it out of the control origin's cookies, API and IndexedDB. The
 * document also carries the isolation headers, which is why the browser still
 * exposes `SharedArrayBuffer` to it and to its workers. */
export const POD_HOST_HTML_PATH = "/noite-pod-host.html";
export const POD_HOST_JS_PATH = "/noite-pod-host.js";
export const POD_HOST_PATHS = [POD_HOST_HTML_PATH, POD_HOST_JS_PATH] as const;

/** Nodepod's process-worker bundle and its preview service worker, as paths.
 * The *preview* host serves both: the frame boots Nodepod there, so its
 * workers and the (once, query-free) service worker that routes preview
 * requests belong to that origin. See `CONTROL_HOST_DENIED_ASSETS` for why the
 * control origin must answer 404 for them instead. */
export const POD_WORKER_PATH = "/__worker__.js";
export const POD_SW_PATH = "/__sw__.js";

/** Every path that belongs to a pod and is answered on the Preview host only:
 * the pod host document and its bundle, plus Nodepod's own runtime assets. */
export const PREVIEW_HOST_ASSETS = [
  ...POD_HOST_PATHS,
  POD_SW_PATH,
  POD_WORKER_PATH,
] as const;

/** The deployment's asset directory, as the Preview host answers it. The frame
 * bundle is built into the control UI's client bundle, so the chunks it loads
 * at runtime — Vite's own runtime and preload helper, and any module it shares
 * with the control UI — are emitted as `/assets/<name>-<hash>.js`. The frame
 * document *is* the app's preview origin, and it has to be able to load them;
 * on the control origin the very same paths are the control UI's own assets,
 * served exactly as before. */
export const PREVIEW_ASSET_PREFIX = "/assets/";

/** The dev server's own URL space, as the pod host's service worker must treat
 * it: host paths, never a pod's.
 *
 * In dev the frame's document loads Vite's module graph (`POD_HOST_DEV_JS`)
 * instead of the built bundle, so the frame's own assets are spread over the
 * app root: the control UI's and the pod host's sources under `src/`, and
 * Vite's prebundled dependencies (`node_modules/.vite/deps/`). A *build* needs
 * none of this: its entry is one file at `POD_HOST_JS_PATH`, and `/assets/*`
 * (see `PREVIEW_ASSET_PREFIX`) is the only other root it reads.
 *
 * Reserving them is what keeps the frame loadable once a pod has claimed the
 * origin root. Nodepod's service worker routes a same-origin request that
 * is neither a reserved host path nor a subresource of a reserved host document
 * to the pod that claimed its referrer's path — walking the path up to `/`,
 * where a pod's own claim sits. A module fetch carries the
 * *importing* module as its referrer, so the frame's graph is only the host's
 * while every module in it is reserved (the frame's document is, and its first
 * imports are too, but each deeper module refers to an unreserved one). Without
 * this, the second load of the frame — the handshake retry, a reload, a second
 * tab — has its modules answered by the app's own dev server. */
export const POD_HOST_DEV_PATHS = ["/src/", "/node_modules/"] as const;

/** Nodepod's preview bridge: the document (and its script) that registers a
 * service worker against its own origin with `swUrl` taken from the query.
 * Dead in this build — the pod host boots with `previewOrigin: false`, so no
 * bridge document is ever created — but Nodepod's Vite plugin still serves the
 * pair in dev and emits it into the client bundle, so the control host has to
 * answer 404 for it: a bridge document on the control origin is a *registerable*
 * service worker there, reachable from a crafted link. */
export const POD_BRIDGE_PATHS = [
  "/__nodepod_bridge__.html",
  "/__nodepod_bridge__.js",
] as const;

/** The pod assets a request to the *control* origin is answered 404 for: the
 * preview host's own list, plus the dead bridge pair above. Nothing there may
 * create a process worker or register a service worker: a worker inherits the
 * origin of the document that creates it, so a path that let a guest app create
 * one on the control origin would run its code inside the control UI's agent
 * cluster, with the viewer's cookies, API and IndexedDB. With the whole pod on
 * the preview origin, no control-host document needs any of these paths —
 * including the service worker, which used to be registerable from the control
 * page. */
export const CONTROL_HOST_DENIED_ASSETS = [
  ...PREVIEW_HOST_ASSETS,
  ...POD_BRIDGE_PATHS,
] as const;

/** Whether a control-origin request for `path` must be answered 404 (see
 * `CONTROL_HOST_DENIED_ASSETS`). */
export const isControlDeniedAsset = (path: string): boolean => {
  for (const denied of CONTROL_HOST_DENIED_ASSETS) {
    if (denied === path) {
      return true;
    }
  }

  return false;
};

/** Whether a request's `Host` is a Preview host (`app-0.preview.<slug>.<base>`,
 * dev `app-0.preview.<slug>.localhost:9080`). The `PREVIEW_LABEL.preview.`
 * prefix is the shape this file emits, so only a preview host — never the
 * control UI's own host — passes. */
export const isPreviewHost = (host: string | null): boolean => {
  if (host === null) {
    return false;
  }

  const name = host.split(":")[0] ?? "";

  return name.toLowerCase().startsWith(`${PREVIEW_LABEL}.preview.`);
};

/** Why a pod refuses to boot with no preview origin: the pod's own code — the
 * installer and its scripts, the app's dev script, a build, the terminal — runs
 * in a document on that origin, and there is nowhere else it may run, so a page
 * whose preview origin could not be read refuses to open a workspace at all
 * rather than running without that separation. */
export const NO_POD_HOST_MESSAGE =
  "The workspace could not open: this page has no preview origin for the app (the preview host could not be read), and the workspace's code must not run on this origin. Reload the page to try again.";

/** Why a secure page gets no preview origin in dev: the local preview host
 * is plain http (see `previewOrigin` above), which browsers block inside a
 * secure page as mixed content. Lives here — not in `preview.server.ts` —
 * so the browser can read it too: only actions cross a `.server.ts`
 * boundary, never plain values. */
export const PREVIEW_MIXED_CONTENT_MESSAGE =
  "Preview cannot run from this page: its preview host is plain http, which browsers block inside a secure page. In dev, open the UI on http://noite.localhost:9080, or on an https host listed in CONTROL_EXTRA_HOSTS (e.g. https://noite.local).";
