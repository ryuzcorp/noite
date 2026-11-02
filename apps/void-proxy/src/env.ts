/** Proxy input contract (rendered by the runner; see SPEC.md "Void platform proxy") plus the minimal platform surfaces the proxy needs. */

/** Minimal KV surface the proxy needs for ISR purge. Real `KVNamespace` satisfies this. */
export interface IsrKvNamespace {
  list: (options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }) => Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  delete: (key: string) => Promise<void>;
}

/** Minimal KV surface the proxy needs for mail idempotency. */
export interface MailKvNamespace {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ) => Promise<void>;
}

/** Minimal `cloudflare:sockets` surface the SMTP client needs. */
export interface ProxySocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close: () => Promise<void>;
  startTls: (options?: { expectedServerHostname?: string }) => ProxySocket;
}

export type SocketConnect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls" }
) => ProxySocket;

/**
 * Proxy environment. Every field arrives as a plain-text var or a binding the
 * runner renders per fleet. Optional here so a missing value fails closed with
 * an explicit error instead of crashing; SPEC.md marks which fields each
 * endpoint requires.
 *
 * Security rule: proxy vars must never hold an operator-wide secret (no shared
 * SMTP password, no shared AI gateway key). Per-app credentials only.
 */
export interface Env {
  /** Noite app id. `projectId` in every request body is pinned to this. */
  readonly __PROJECT_ID?: string;
  /** Per-fleet random token. Compared in constant time. */
  readonly __VOID_PROXY_TOKEN?: string;
  /** App slug. `/email/send` pins the `from` local part to it. */
  readonly __VOID_PROJECT_SLUG?: string;
  /** Operator mail domain. `/email/send` pins the `from` domain to it. */
  readonly __VOID_EMAIL_DOMAIN?: string;
  /** Same KV namespace id the app uses for ISR. Required for `/revalidate`. */
  readonly ISR_CACHE?: IsrKvNamespace;
  /** Fixed-id KV namespace for mail idempotency records. Required for `/email/send`. */
  readonly MAIL_IDEMPOTENCY?: MailKvNamespace;
  /** SMTP relay host. Email is enabled iff this is set. */
  readonly VOID_PROXY_SMTP_HOST?: string;
  /** SMTP relay port (`starttls` → 587, `implicit` → 465, `plain` → 25 by default). */
  readonly VOID_PROXY_SMTP_PORT?: string;
  /** `starttls` (default) | `implicit` | `plain`. */
  readonly VOID_PROXY_SMTP_MODE?: string;
  /** `plain` mode is refused unless this is exactly `1`. */
  readonly VOID_PROXY_SMTP_ALLOW_PLAINTEXT?: string;
  /** Per-app SMTP credential (proxy-only setting, never in app vars). */
  readonly VOID_PROXY_SMTP_USERNAME?: string;
  /** Per-app SMTP credential (proxy-only setting, never in app vars). */
  readonly VOID_PROXY_SMTP_PASSWORD?: string;
  /** Comma/whitespace-separated allowlist: exact addresses or `@domain` suffixes. */
  readonly VOID_PROXY_EMAIL_ALLOWLIST?: string;
  /** `/ai/*` answers 501 unless this is exactly `1`. */
  readonly VOID_PROXY_AI_ENABLED?: string;
  /** JSON model map for `/ai/run`: `{ "<model>": { "endpoint", "model" } }`. */
  readonly VOID_PROXY_AI_MODELS?: string;
  /** Per-app key for the operator AI endpoint (absent = keyless endpoint). */
  readonly VOID_PROXY_AI_API_KEY?: string;
}

/** Test seams. Production callers omit this and get the platform defaults. */
export interface ProxyDeps {
  readonly connectSocket?: SocketConnect;
  readonly fetchUpstream?: (
    url: string,
    init: RequestInit
  ) => Promise<Response>;
  readonly timeouts?: {
    readonly smtpConnectMs?: number;
    readonly smtpCommandMs?: number;
    readonly emailTotalMs?: number;
  };
}
