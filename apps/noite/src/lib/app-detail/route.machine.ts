//! One parser per page's URL state, so "what will this link show" has one
//! answer (APP-11) and a stale `?env=` is an explicit notice instead of a
//! silent switch to production (APP-3).
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Default
//!   Default --> Requested: parse valid param
//!   Default --> Notice: param names a deleted environment
//!   Default --> Default: unknown tab / panel (kept for external links)
//! ```
//!
//! The wire stays exactly as before: `?t=`, `?panel=settings`, `?env=<id>`
//! (`""` = production), `?es=`, `?r=`, `?e=`. Only the *composition* is one
//! value, and only a stale environment produces a notice — an unknown tab or
//! panel still falls back quietly, since old links keep working.

import { Data } from "effect";

import type { RunnerEnvironment } from "../runner";

export const APP_TABS = [
  "overview",
  "deployments",
  "metrics",
  "errors",
  "events",
] as const;

export type AppTab = (typeof APP_TABS)[number];

export type AppPanel = "" | "settings";

/** Which environment a telemetry/deploy panel shows. `Production` carries the
 * wire's `""`; `Environment` its id. */
export type AppScope = Data.TaggedEnum<{
  Production: Record<never, never>;
  Environment: { readonly id: string };
}>;

export const AppScopeTypes = Data.taggedEnum<AppScope>();

export const scopeId = (scope: AppScope): string =>
  scope._tag === "Environment" ? scope.id : "";

export type RouteNotice = Data.TaggedEnum<{
  None: Record<never, never>;
  StaleEnvironment: { readonly id: string };
}>;

export const RouteNoticeTypes = Data.taggedEnum<RouteNotice>();

/** `?t=`: an unknown tab is Overview (a shared link never 404s). */
export const parseAppTab = (raw: string): AppTab =>
  APP_TABS.find((tab) => tab === raw) ?? "overview";

/** `?panel=`: anything but `settings` closes the panel. */
export const parseAppPanel = (raw: string): AppPanel =>
  raw === "settings" ? "settings" : "";

export interface ScopeParse {
  readonly notice: RouteNotice;
  readonly scope: AppScope;
}

/** `?env=` against the app's environments: exactly one closed decision, and a
 * deleted id is a notice, not production-by-stealth. */
export const parseScope = (
  raw: string,
  envs: readonly RunnerEnvironment[] | undefined
): ScopeParse => {
  // Still loading the environment list: an id cannot be judged yet, so no
  // stale-environment notice is invented.
  if (envs === undefined || raw === "") {
    return {
      notice: RouteNoticeTypes.None(),
      scope: AppScopeTypes.Production(),
    };
  }

  if (envs.some((env) => env.id === raw)) {
    return {
      notice: RouteNoticeTypes.None(),
      scope: AppScopeTypes.Environment({ id: raw }),
    };
  }

  return {
    notice: RouteNoticeTypes.StaleEnvironment({ id: raw }),
    scope: AppScopeTypes.Production(),
  };
};

/** The Errors tab's status filter (`?es=`). */
export type ErrorFilter = "ignored" | "open" | "resolved";

export const parseErrorFilter = (raw: string): ErrorFilter => {
  if (raw === "resolved" || raw === "ignored") {
    return raw;
  }

  return "open";
};

/** The app page's whole route state. */
export interface AppRoute {
  readonly notice: RouteNotice;
  readonly panel: AppPanel;
  readonly scope: AppScope;
  readonly tab: AppTab;
}

export const parseAppRoute = (
  params: { readonly env: string; readonly panel: string; readonly t: string },
  envs: readonly RunnerEnvironment[] | undefined
): AppRoute => {
  const { notice, scope } = parseScope(params.env, envs);

  return {
    notice,
    panel: parseAppPanel(params.panel),
    scope,
    tab: parseAppTab(params.t),
  };
};
