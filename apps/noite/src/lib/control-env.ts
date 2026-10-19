import type { D1Database } from "@cloudflare/workers-types";

/** Values the control env bag carries: strings from process/compose env plus
 * the platform's pre-built D1 binding object. */
export type ControlEnvValue = string | D1Database;

/** Shared control env bag (must be a plain object — process.env stringifies values). */
export const controlEnv: Record<string, ControlEnvValue> = {};

export const hydrateControlEnv = (
  // SAFETY: defaulting to process.env crashes on Workers (no process) — guard with typeof, which is safe on undefined globals.
  from:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = typeof process === "undefined"
    ? {}
    : process.env
) => {
  for (const [key, value] of Object.entries(from)) {
    if (
      value !== undefined &&
      // SAFETY: durable bindings are pre-built plain objects (already hydrated); overwriting them from process.env would wipe the binders, so only string primitives are refreshed here.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      typeof controlEnv[key] !== "object"
    ) {
      controlEnv[key] = value;
    }
  }

  // Dev-process fallback only (vite dev has no compose env for the worker).
  // Prod values always arrive via compose environment / void.config.ts vars /
  // deploy env — never rely on these outside localhost dev. `noite.localhost`
  // is the dev base every `*.localhost` workaround keys on (`isLocalhostDomain`).
  // The control plane only talks to the runner; it holds no S3 credentials of
  // its own.
  const defaults = {
    BASE_DOMAIN: "noite.localhost",
    RUNNER_URL: "http://127.0.0.1:8080",
  } satisfies Record<string, string>;

  for (const [key, value] of Object.entries(defaults)) {
    if (controlEnv[key] === undefined) {
      controlEnv[key] = value;
    }
  }
};
