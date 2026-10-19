//! `/api/env-auth`: the hand-off the runner's edge 302s a browser into when a
//! members-only environment needs a grant. It resolves the viewer's session
//! and `view` role here (the runner has no session), mints the short-lived
//! grant through `environments.grant`, and sends the browser on to the
//! environment's own `/__noite/auth` — the host rebuilt from the environment's
//! label, the app's slug and the base, never from the `return` parameter.

import { requireAppRole } from "../../lib/collaborators";
import { ensureDbPromise } from "../../lib/db";
import {
  environmentHost,
  environmentReturnPath,
  envAuthLocation,
  sameOriginPath,
} from "../../lib/env-auth";
import { isLocalhostDomain } from "../../lib/local-host";
import { previewBase } from "../../lib/preview-host";
import {
  runnerEnvironmentGrant,
  runnerEnvironmentsList,
} from "../../lib/runner";
import { getSessionOrNull } from "../../lib/server/session.server";
import type { RouteHandler } from "../config";

const redirect = (location: string): Response =>
  new Response(null, { headers: { location }, status: 302 });

/** Styles of the refusal pages: self-contained (this route ships no bundle,
 * and the frame may be a phone-width pane), readable in a dark or light
 * frame, and the link is the page's only interactive thing. */
const NOTICE_CSS = `:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font:14px/1.5 system-ui,sans-serif;background:#f4f4f5;color:#18181b}main{max-width:28rem}h1{margin:0 0 .5rem;font-size:1.05rem}p{margin:0 0 .75rem}a{color:inherit;font-weight:600;text-decoration:underline}@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}}`;

/** One refusal, as a page: a preview frame shows it where the environment
 * would have been, so a bare line of text (or the login form) is not an
 * answer the visitor can act on. `action` is the page's way out, opening
 * top-level when it is a sign-in. */
const noticePage = (
  status: number,
  title: string,
  message: string,
  action?: { href: string; label: string }
): Response => {
  const link =
    action === undefined
      ? ""
      : `<p><a href="${action.href}" target="_top" rel="noopener">${action.label}</a></p>`;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${NOTICE_CSS}</style></head><body><main><h1>${title}</h1><p>${message}</p>${link}</main></body></html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
      status,
    }
  );
};

/** The dev port from a forwarded host (`host:9080`); "" when it carries none.
 * Only ever used on a localhost base, where the port is not browser-optional. */
const forwardedPort = (host: string): string => {
  const at = host.lastIndexOf(":");

  if (at === -1) {
    return "";
  }

  const port = host.slice(at + 1);

  return /^\d+$/u.test(port) ? port : "";
};

/** The environment's own origin for this request: the base follows the page
 * onto a `CONTROL_EXTRA_HOSTS` entry, and the dev port is kept on a localhost
 * base. Never read from `return`. */
const envOriginFor = (
  url: URL,
  forwarded: string,
  env: KitEnv,
  slug: string,
  label: string
) => {
  const base = previewBase(
    forwarded || url.host,
    env.BASE_DOMAIN ?? "localhost",
    env.CONTROL_EXTRA_HOSTS
  );

  const localhost = isLocalhostDomain(base);
  const port = localhost ? forwardedPort(forwarded) || url.port : "";
  const host = environmentHost(label, slug, base, port);

  return { host, origin: `${localhost ? "http" : "https"}://${host}` };
};

/** A signed-out viewer goes back to this exact hand-off after signing in. */
const loginPath = (url: URL): string => {
  const back = sameOriginPath(`${url.pathname}${url.search}`) ?? "/apps";

  return `/login?return=${encodeURIComponent(back)}`;
};

const loginRedirect = (url: URL): Response => redirect(loginPath(url));

/** Resolve the environment the hand-off names, or the refusal to answer with.
 * The caller's role is resolved before this and passed through to the
 * runner, which enforces it again. */
const resolveEnvironment = async (
  appId: string,
  envId: string,
  role: string
): Promise<{ label: string } | Response> => {
  let label: string | undefined;

  try {
    const list = await runnerEnvironmentsList(appId, role);
    label = list.find((row) => row.id === envId)?.label;
  } catch {
    return noticePage(
      502,
      "Preview environment unavailable",
      "The runner did not answer. This is usually momentary — retry in a moment."
    );
  }

  if (!label) {
    return noticePage(
      404,
      "This preview expired or was deleted",
      "Deploy a preview of this branch from Code mode's Preview panel, or create the branch's environment on the Deployments tab."
    );
  }

  return { label };
};

export const handleEnvAuth: RouteHandler = async (request, env) => {
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const envId = url.searchParams.get("env")?.trim() ?? "";
  const appId = url.searchParams.get("app")?.trim() ?? "";

  if (!envId || !appId) {
    return new Response("env and app are required", { status: 400 });
  }

  await ensureDbPromise();
  const session = await getSessionOrNull(request, env).catch(() => null);
  const user = session?.user;

  if (!user) {
    // Inside a preview frame the login form is not an answer (the frame's
    // visitor cannot complete it there): the page says so and offers the
    // sign-in top-level, where the session cookie is set.
    if (request.headers.get("sec-fetch-dest") === "iframe") {
      return noticePage(
        401,
        "Sign in to view this preview",
        "This preview belongs to a members-only environment.",
        { href: loginPath(url), label: "Sign in" }
      );
    }

    return loginRedirect(url);
  }

  const grant = await requireAppRole(appId, user.id, "view").catch(() => null);

  if (!grant) {
    return noticePage(
      403,
      "You don't have access to this environment",
      "This preview is members-only. Ask an app admin to add you as a collaborator, then reload it."
    );
  }

  const resolved = await resolveEnvironment(appId, envId, grant.role);

  if (resolved instanceof Response) {
    return resolved;
  }

  const forwarded = request.headers.get("x-forwarded-host") ?? "";

  const { host, origin } = envOriginFor(
    url,
    forwarded,
    env,
    grant.app.slug,
    resolved.label
  );

  const returnPath = environmentReturnPath(
    url.searchParams.get("return") ?? "",
    host
  );

  const { token } = await runnerEnvironmentGrant(appId, envId, user.id);

  return redirect(envAuthLocation(origin, token, returnPath));
};
