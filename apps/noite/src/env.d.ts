/// <reference types="vite/client" />
/// <reference types="bun" />

/** Bun / Oxide `env` bag (preset: fetch). */
interface KitEnv {
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
  NOITE_DB?: string;
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
