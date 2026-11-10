/**
 * Per-subsystem proxy configuration, derived from `Env` in one place so the
 * capability gate in `worker.ts`, `/health`, and every handler read the same
 * state.
 *
 * Each subsystem is one closed union with exactly three states:
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> Off: required var absent
 *     [*] --> Misconfigured: var set but unusable
 *     [*] --> Ready: all vars present and valid
 *     Misconfigured --> Ready: operator fixes the env
 *     Ready --> Misconfigured: operator breaks the env
 * ```
 *
 * | subsystem    | Off                          | Misconfigured                                  |
 * | ------------ | ---------------------------- | ---------------------------------------------- |
 * | `email`      | no `VOID_PROXY_SMTP_HOST`    | bad mode/port, plaintext without allowance     |
 * | `senderDomain` | no `__VOID_EMAIL_DOMAIN`   | —                                              |
 * | `isr`        | no `ISR_CACHE` binding       | —                                              |
 * | `mailKv`     | no `MAIL_IDEMPOTENCY` binding | —                                             |
 *
 * The AI subsystem is two independent facts: `enabled` (the operator flag)
 * and `models` (`Off`-less: `Ready` with a possibly empty map, or
 * `Misconfigured` when the JSON is unusable). `/health` reports both exactly
 * as before, and `/ai/run` acts only on the same two facts.
 *
 * Transitions happen only when the operator changes the environment; nothing
 * here is cached across requests, so every request sees one consistent
 * snapshot.
 */

import { isRecord, sanitizeForLog } from "./auth.ts";
import type { SmtpMode } from "./email/smtp.ts";
import { readSenderDomain } from "./email/validate.ts";
import type { Env, IsrKvNamespace, MailKvNamespace } from "./env.ts";

/* oxlint-disable anti-slop/no-runtime-typeof -- Env values are plain-text vars rendered by the runner, so typeof narrows the untyped boundary before use */

/**
 * `Off` means the operator never configured the subsystem (answer 501);
 * `Misconfigured` means a value is present but unusable (answer 502 with the
 * detail); `Ready` is the only state a handler may act on.
 */
export type Subsystem<T> =
  | { readonly _tag: "Off" }
  | { readonly _tag: "Ready"; readonly value: T }
  | { readonly _tag: "Misconfigured"; readonly detail: string };

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly mode: SmtpMode;
  readonly username: string | null;
  readonly password: string;
}

export type EmailConfig = Subsystem<SmtpConfig>;

export interface AiModelMapping {
  readonly endpoint: string;
  readonly model: string;
}

export type AiModelsConfig =
  | {
      readonly _tag: "Ready";
      readonly models: Readonly<Record<string, AiModelMapping>>;
    }
  | { readonly _tag: "Misconfigured"; readonly detail: string };

export interface AiConfig {
  /** `VOID_PROXY_AI_ENABLED === "1"`: the `/ai/*` capability gate. */
  readonly enabled: boolean;
  readonly models: AiModelsConfig;
}

export interface ProxyConfig {
  readonly ai: AiConfig;
  readonly email: EmailConfig;
  readonly isr: Subsystem<IsrKvNamespace>;
  readonly mailKv: Subsystem<MailKvNamespace>;
  readonly senderDomain: Subsystem<string>;
}

const isSmtpMode = (value: string): value is SmtpMode =>
  value === "starttls" || value === "implicit" || value === "plain";

const DEFAULT_SMTP_PORTS: Record<SmtpMode, number> = {
  implicit: 465,
  plain: 25,
  starttls: 587,
};

/**
 * Read the SMTP relay config. `Off` is the capability gate's 501; a
 * `Misconfigured` detail is surfaced verbatim as the existing 502 body.
 */
export const readSmtpConfig = (env: Env): EmailConfig => {
  const host = (env.VOID_PROXY_SMTP_HOST ?? "").trim();

  if (!host) {
    return { _tag: "Off" };
  }

  const modeRaw = (env.VOID_PROXY_SMTP_MODE ?? "starttls").trim().toLowerCase();

  if (!isSmtpMode(modeRaw)) {
    return {
      _tag: "Misconfigured",
      detail: `email smtp mode must be starttls, implicit or plain (got ${sanitizeForLog(modeRaw, 32)})`,
    };
  }

  const mode = modeRaw;

  if (mode === "plain" && env.VOID_PROXY_SMTP_ALLOW_PLAINTEXT !== "1") {
    return {
      _tag: "Misconfigured",
      detail:
        "email smtp plaintext mode requires the operator plaintext allowance",
    };
  }

  const portRaw = (env.VOID_PROXY_SMTP_PORT ?? "").trim();
  let port = DEFAULT_SMTP_PORTS[mode];

  if (portRaw !== "") {
    if (!/^\d+$/u.test(portRaw)) {
      return { _tag: "Misconfigured", detail: "email smtp port is invalid" };
    }

    port = Number(portRaw);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { _tag: "Misconfigured", detail: "email smtp port is invalid" };
    }
  }

  const usernameRaw = env.VOID_PROXY_SMTP_USERNAME;

  return {
    _tag: "Ready",
    value: {
      host,
      mode,
      password:
        typeof env.VOID_PROXY_SMTP_PASSWORD === "string"
          ? env.VOID_PROXY_SMTP_PASSWORD
          : "",
      port,
      username:
        typeof usernameRaw === "string" && usernameRaw.length > 0
          ? usernameRaw
          : null,
    },
  };
};

const readAiModels = (env: Env): AiModelsConfig => {
  const raw = (env.VOID_PROXY_AI_MODELS ?? "").trim();

  if (!raw) {
    return { _tag: "Ready", models: {} };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { _tag: "Misconfigured", detail: "ai model map invalid" };
  }

  if (!isRecord(parsed)) {
    return { _tag: "Misconfigured", detail: "ai model map invalid" };
  }

  const models: Record<string, AiModelMapping> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (
      isRecord(value) &&
      typeof value.endpoint === "string" &&
      typeof value.model === "string"
    ) {
      models[key] = { endpoint: value.endpoint, model: value.model };
    }
  }

  return { _tag: "Ready", models };
};

export const readProxyConfig = (env: Env): ProxyConfig => {
  const senderDomain = readSenderDomain(env);

  return {
    ai: {
      enabled: env.VOID_PROXY_AI_ENABLED === "1",
      models: readAiModels(env),
    },
    email: readSmtpConfig(env),
    isr: env.ISR_CACHE
      ? { _tag: "Ready", value: env.ISR_CACHE }
      : { _tag: "Off" },
    mailKv: env.MAIL_IDEMPOTENCY
      ? { _tag: "Ready", value: env.MAIL_IDEMPOTENCY }
      : { _tag: "Off" },
    senderDomain:
      senderDomain === null
        ? { _tag: "Off" }
        : { _tag: "Ready", value: senderDomain },
  };
};
