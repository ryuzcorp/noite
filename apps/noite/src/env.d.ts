/// <reference types="vite/client" />
/// <reference types="bun" />

import type { D1Database } from "@cloudflare/workers-types";

/** Worker `env` bag (preset: worker) — strings plus the D1 binding.
 * Declared global: this file has imports (making it a module), so a plain
 * interface would be module-scoped and invisible to consumers. */
declare global {
  interface KitEnv {
    DB?: D1Database;
    NOITE_EMAIL_WEBHOOK_URL?: string;
    /** Platform requests per minute per client per route class on the public
     * routes (`/api/auth/*`, `/api/invite/status`); `0` disables it. */
    NOITE_RATE_LIMIT_RPM?: string;
    /** Better-auth's own per-client budget per minute (`/api/auth/*`). */
    NOITE_AUTH_RATE_LIMIT?: string;
    /** @deprecated use RUNNER_TOKEN */
    AGENT_TOKEN?: string;
    /** @deprecated use RUNNER_URL */
    AGENT_URL?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_REGION?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    BASE_DOMAIN?: string;
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_URL?: string;
    NOITE_ADMIN_EMAIL?: string;
    NOITE_SMTP_FROM?: string;
    /** @deprecated use RUNNER_TOKEN */
    HOST_TOKEN?: string;
    /** @deprecated use RUNNER_URL */
    HOST_URL?: string;
    RUNNER_TOKEN?: string;
    RUNNER_URL?: string;
    RUSTFS_ACCESS_KEY?: string;
    RUSTFS_SECRET_KEY?: string;
    S3_ENDPOINT?: string;
    S3_PUBLIC_ENDPOINT?: string;
  }
}
