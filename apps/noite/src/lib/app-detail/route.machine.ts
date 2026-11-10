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
//! (`""` = production), `?es=`, `?r=`, `?e=`, plus the Settings view's
//! `?section=`. Only the *composition* is one value, and only a stale
//! environment produces a notice — an unknown tab, panel or section still
//! falls back quietly, since old links keep working.

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

/** The Settings view's sections (`/apps/<id>/settings?section=…`), in display
 * order. `branch-protection` and `danger` are admin-only: a non-admin never
 * sees their tab, and a shared link to one lands on the default section. */
export const SETTINGS_SECTIONS = [
  "identity",
  "domains",
  "limits",
  "error-reporting",
  "collaborators",
  "env",
  "branch-protection",
  "danger",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "identity";

const SETTINGS_SECTION_META = {
  "branch-protection": { adminOnly: true, label: "Branch protection" },
  collaborators: { adminOnly: false, label: "Collaborators" },
  danger: { adminOnly: true, label: "Danger zone" },
  domains: { adminOnly: false, label: "Domains" },
  env: { adminOnly: false, label: "Environment variables" },
  "error-reporting": { adminOnly: false, label: "Error reporting" },
  identity: { adminOnly: false, label: "Identity" },
  limits: { adminOnly: false, label: "Limits" },
} as const satisfies Record<
  SettingsSection,
  { readonly adminOnly: boolean; readonly label: string }
>;

export const settingsSectionLabel = (section: SettingsSection): string =>
  SETTINGS_SECTION_META[section].label;

/** The sections this role may open, in display order: the tab row. */
export const settingsSectionsFor = (
  isAdmin: boolean
): readonly SettingsSection[] =>
  SETTINGS_SECTIONS.filter(
    (section) => isAdmin || !SETTINGS_SECTION_META[section].adminOnly
  );

/** `?section=`: an unknown id — or one this role may not open — is the
 * default section, so an old or shared link never renders an empty view. */
export const parseSettingsSection = (
  raw: string,
  isAdmin: boolean
): SettingsSection => {
  const known = SETTINGS_SECTIONS.find((section) => section === raw);

  if (known === undefined) {
    return DEFAULT_SETTINGS_SECTION;
  }

  return settingsSectionsFor(isAdmin).includes(known)
    ? known
    : DEFAULT_SETTINGS_SECTION;
};

/** Settings used to be a side panel on the app page (`?panel=settings`). It
 * has its own view now, so an old link redirects there; a known `?section=`
 * deep link rides along, an unknown one is dropped (the view's parser would
 * land on the default anyway, and a clean URL is the honest one). */
export const legacySettingsHref = (
  appId: string,
  rawSection: string
): string => {
  const known = SETTINGS_SECTIONS.find((section) => section === rawSection);

  return `/apps/${encodeURIComponent(appId)}/settings${
    known === undefined ? "" : `?section=${known}`
  }`;
};

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
  envs?: readonly RunnerEnvironment[] | undefined
): AppRoute => {
  const { notice, scope } = parseScope(params.env, envs);

  return {
    notice,
    panel: parseAppPanel(params.panel),
    scope,
    tab: parseAppTab(params.t),
  };
};
