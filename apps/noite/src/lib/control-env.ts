import type { D1Database } from "@cloudflare/workers-types";

/** Values the control env bag carries: strings from process/compose env plus
 * the platform's pre-built D1 binding object. */
export type ControlEnvValue = string | D1Database;

/** Shared control env bag (must be a plain object — process.env stringifies values). */
export const controlEnv: Record<string, ControlEnvValue> = {};

/** Every string key the control worker reads from its environment, in one
 * list: the middleware stamps all of them from the platform env on every
 * request (the runner deploys them as worker vars; `void.config.ts` carries
 * the dev defaults). A partial stamp is how the first-admin gate went inert
 * on deployed installs (only the runner keys were stamped, so `BASE_DOMAIN`
 * read the dev default and the anchor read as unset). */
export const CONTROL_ENV_KEYS = [
  "BASE_DOMAIN",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CONTROL_EXTRA_HOSTS",
  "GIT_PUBLIC_BASE",
  "NOITE_ADMIN_EMAIL",
  "NOITE_AUTH_RATE_LIMIT",
  "NOITE_EMAIL_WEBHOOK_URL",
  "NOITE_RATE_LIMIT_RPM",
  "NOITE_SMTP_FROM",
  "RUNNER_TOKEN",
  "RUNNER_URL",
] as const satisfies readonly Exclude<keyof KitEnv, "DB">[];

type StampedKeys = (typeof CONTROL_ENV_KEYS)[number];

// Every declared string key is stamped: adding a `KitEnv` key without
// listing it here fails the build instead of silently serving a default.
// `DB` is the platform's pre-built binding object (stamped separately via
// `setD1Binding`), never a string.
const _allKeysStamped: Exclude<keyof KitEnv, "DB" | StampedKeys> extends never
  ? true
  : never = true;

/** Stamp the platform env into the request-scoped bag. Present strings win
 * (even empty — an unset var on redeploy must clear, not linger); absent
 * keys keep what hydration or an earlier stamp left. */
export const stampControlEnv = (env: KitEnv): void => {
  for (const key of CONTROL_ENV_KEYS) {
    const value = env[key];

    // The stamp is the I/O boundary: the platform bag carries strings plus
    // the pre-built D1 binding, and only strings may enter the env bag.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary parse: strings in, binding stays out.
    if (typeof value === "string") {
      controlEnv[key] = value;
    }
  }
};

/** The base the control worker serves: the stamped `BASE_DOMAIN`, or "" when
 * the platform provided none. Empty is NEVER localhost: a deployed worker
 * without a base is misconfigured, and the setup gate must stay strict
 * (fail closed) rather than silently taking the dev default. Dev fills the
 * default through `hydrateControlEnv`, so only a broken deploy sees "". */
export const controlBaseDomain = (): string => {
  const value: unknown = controlEnv.BASE_DOMAIN;

  // The bag is an untyped record at runtime (tests stamp raw doubles); this
  // read establishes the string contract, "" when it is absent or foreign.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- read-site contract over the untyped bag: string or "".
  return typeof value === "string" ? value : "";
};

export const hydrateControlEnv = (
  // SAFETY: defaulting to process.env crashes on Workers without node compat — guard with typeof, which is safe on undefined globals.
  from:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = typeof __CONTROL_BUILD__ ===
    "undefined" && typeof process !== "undefined"
    ? process.env
    : {}
) => {
  // Production bundles (the deployed worker included) never hydrate: the
  // platform env arrives per request through `stampControlEnv`. Copying
  // ambient `process.env` — present in the worker under `nodejs_compat`
  // (Void enables it when auth is on) — or filling dev defaults would mask
  // a misconfigured deploy as localhost (fail open): with no default, such
  // a worker reads "" and the setup gate fails closed to its strict modes.
  // Only unbundled contexts (bun tests, scripts without a vite transform)
  // hydrate, where `__CONTROL_BUILD__` is undefined. (`vite dev` carries the
  // marker too and gets everything it needs from the stamped request env.)
  if (typeof __CONTROL_BUILD__ !== "undefined") {
    return;
  }

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

  // Dev/test fallback only (see the gate above): `noite.localhost`
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
