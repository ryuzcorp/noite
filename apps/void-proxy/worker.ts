/**
 * Noite Void-compatibility proxy worker.
 *
 * One runner-owned script cohosted in each Void app's fleet (celld `services`).
 * Serves `POST /revalidate`, `POST /email/send` and `POST /ai/*` to the tenant
 * app over its in-fleet `__VOID_PROXY` service binding. The proxy is never
 * publicly routable.
 *
 * Deploy: this file is the celld `main` entry (celld bundles `.ts` with esbuild
 * at deploy, so no build step is needed). The runner copies it verbatim and
 * renders the `Env` vars documented in SPEC.md ("Void platform proxy").
 *
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy"): ISR key helpers
 * (`normalizeIsrPath`, `splitIsrCacheKey`, `isrCacheKey`,
 * `isrCacheVariantPrefix`, `hashOriginalUrl`), the `/email/send` validation
 * chain, MIME `From:` pinning, the provider envelope codec and the
 * path-traversal guard. Adaptations for Noite (KV idempotency instead of SQL
 * admission, SMTP transport instead of the `send_email` binding, a static
 * native provider map instead of the AI gateway) are marked inline.
 *
 * Globals used: `fetch`, `crypto`, KV bindings, `cloudflare:sockets`. `caches`
 * is deliberately never touched (celld's cache is always-miss; KV is
 * authoritative) — a test asserts this file contains no `caches` reference.
 */

/* oxlint-disable eslint/max-classes-per-file -- the classes are the error taxonomy (one per failure kind) plus the SMTP line reader */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

// ---------------------------------------------------------------------------
// Input contract (rendered by the runner; see SPEC.md "Void platform proxy").
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
const LARGE_JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;

const DIRECT_ISR_PROJECT_ID = "__void_direct__";
const ISR_CACHE_KEY_VERSION = "v3";
const ISR_VARIANT_SEPARATOR = "#rw=";

/** Cross-deployment scan prefix for ISR purge (all deployment ids at once). */
export const ISR_V3_PREFIX = `${DIRECT_ISR_PROJECT_ID}/isr/${ISR_CACHE_KEY_VERSION}/`;
export const ISR_HOST_REGISTRY_PREFIX = "void-isr-hosts/";

/** Ported from Void `platform/packages/proxy/src/email.ts`. */
export const MAX_MIME_BYTES = 5 * 1024 * 1024;
const MAX_CUSTOM_HEADER_BYTES = 16 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_RECIPIENT_LENGTH = 320;
const MAX_SENDER_LENGTH = 320;
const MAX_REQUEST_ID_LENGTH = 128;
const IDEMPOTENCY_KEY_PREFIX = "idemp/v1/";

// 24 h
const IDEMPOTENCY_TTL_SECONDS = 86_400;
const EMAIL_SEND_DEADLINE_MS = 50_000;
const EMAIL_SEND_FINALIZATION_MARGIN_MS = 5000;
const EMAIL_PROVIDER_DEADLINE_MS = 30_000;
const SMTP_CONNECT_TIMEOUT_MS = 10_000;
const SMTP_COMMAND_TIMEOUT_MS = 10_000;
const SMTP_MAX_LINE_BYTES = 8192;
const SMTP_MAX_REPLY_LINES = 128;
const SMTP_MESSAGE_ID_MAX_CHARS = 128;
const SMTP_REPLY_TEXT_MAX_CHARS = 200;

const encoder = new TextEncoder();

const fatalDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

// ---------------------------------------------------------------------------
// ISR key helpers — ported byte-identically from Void `packages/isr/src/index.ts`
// (writers, readers and purgers must build byte-identical keys).
// ---------------------------------------------------------------------------

/**
 * Build the normalized path segment for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export const normalizeIsrPath = (pathname: string): string => {
  let normalized = pathname;

  if (normalized === "/") {
    normalized = "__index__";
  } else {
    normalized = normalized.startsWith("/") ? normalized.slice(1) : normalized;

    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
  }

  return normalized;
};

/**
 * Prefix for listing/purging ISR keys. An empty `deploymentId` still yields the
 * versioned prefix, because writers may use an empty id. Only `undefined`
 * selects every key.
 */
export const isrCachePrefix = (
  projectId: string,
  deploymentId?: string
): string => {
  if (deploymentId !== undefined) {
    return `${projectId}/isr/${ISR_CACHE_KEY_VERSION}/${deploymentId}/`;
  }

  return `${projectId}/isr/`;
};

const FNV_OFFSET_BASIS = 0xcb_f2_9c_e4_84_22_23_25n;
const FNV_PRIME = 0x1_00_00_00_01_b3n;
const FNV_MASK = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/**
 * Hash an original URL into a 16-hex-char variant token (FNV-1a 64-bit).
 * Sync so it fits every read/write path; opaque so KV never exposes original
 * URLs. Not cryptographic.
 */
export const hashOriginalUrl = (originalUrl: string): string => {
  const bytes = new TextEncoder().encode(originalUrl);
  let h = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    // oxlint-disable-next-line eslint/no-bitwise -- FNV-1a is defined with xor and masked multiply
    h = (h ^ BigInt(byte)) & FNV_MASK;
    // oxlint-disable-next-line eslint/no-bitwise -- FNV-1a is defined with xor and masked multiply
    h = (h * FNV_PRIME) & FNV_MASK;
  }

  return h.toString(16).padStart(16, "0");
};

/**
 * KV key for an ISR-cached page: `<proj>/isr/v3/<D>/<host>/<path>`.
 * Pass `originalUrl` for a rewrite/query variant (`#rw=<token>` suffix).
 */
export const isrCacheKey = (
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null
): string => {
  const base = `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}`;

  if (!originalUrl) {
    return base;
  }

  return `${base}${ISR_VARIANT_SEPARATOR}${hashOriginalUrl(originalUrl)}`;
};

/** Prefix for listing the `#rw=` variant keys of a pathname (not its direct-hit key). */
export const isrCacheVariantPrefix = (
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string
): string =>
  `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;

/**
 * Split an ISR KV key into its normalized path and its `#rw=` variant token
 * (`null` for a direct hit).
 */
export const splitIsrCacheKey = (
  fullKey: string
): {
  normalizedPath: string;
  variantToken: string | null;
} => {
  const sepIdx = fullKey.indexOf(ISR_VARIANT_SEPARATOR);

  if (sepIdx === -1) {
    return { normalizedPath: fullKey, variantToken: null };
  }

  return {
    normalizedPath: fullKey.slice(0, sepIdx),
    variantToken: fullKey.slice(sepIdx + ISR_VARIANT_SEPARATOR.length),
  };
};

// ---------------------------------------------------------------------------
// Request body + auth
// ---------------------------------------------------------------------------

/** File and binary payload routes need more room than control operations. */
const requestBodyMaxBytes = (path: string): number => {
  switch (path) {
    case "/ai/run":
    case "/ai/provider":
    case "/ai/toMarkdown": {
      return LARGE_JSON_BODY_MAX_BYTES;
    }

    default: {
      // Five MiB of MIME expands to about seven MiB of base64, plus metadata.
      return path.startsWith("/email/")
        ? LARGE_JSON_BODY_MAX_BYTES
        : DEFAULT_JSON_BODY_MAX_BYTES;
    }
  }
};

class RequestBodyError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.status = status;
    this.name = "RequestBodyError";
  }
}

const cancelBody = async (request: Request): Promise<void> => {
  await request.body?.cancel().catch(() => null);
};

/** Bound the request body before JSON parsing or authentication. */
const readRequestJson = async (
  request: Request,
  maxBytes: number
): Promise<unknown> => {
  const declaredLength = request.headers.get("content-length");

  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    await cancelBody(request).catch(() => null);
    throw new RequestBodyError("request body too large", 413);
  }

  if (!request.body) {
    throw new RequestBodyError("invalid JSON body", 400);
  }

  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(1024, maxBytes));
  let size = 0;

  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be counted in arrival order
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      const nextSize = size + chunk.value.byteLength;

      if (nextSize > maxBytes) {
        throw new RequestBodyError("request body too large", 413);
      }

      if (nextSize > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2))
        );

        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }

      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    await reader.cancel().catch(() => null);
    reader.releaseLock();
  }

  if (size === 0) {
    throw new RequestBodyError("invalid JSON body", 400);
  }

  try {
    return JSON.parse(fatalDecoder.decode(bytes.subarray(0, size)));
  } catch {
    throw new RequestBodyError("invalid JSON body", 400);
  }
};

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

/** Constant-time string equality for the per-fleet proxy token. */
const timingSafeEqual = (a: string, b: string): boolean => {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);

  if (ab.byteLength !== bb.byteLength) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < ab.byteLength; i += 1) {
    // oxlint-disable-next-line eslint/no-bitwise -- constant-time compare accumulates xor differences
    diff |= ab[i] ^ bb[i];
  }

  return diff === 0;
};

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status });

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// ---------------------------------------------------------------------------
// POST /revalidate
// ---------------------------------------------------------------------------

/**
 * Delete every key under a prefix (cursor-paginated), returning the count.
 * Used for `all: true` (ISR entries plus the host registry, across all
 * deployment ids — old-deployment keys are orphans, so this also GCs them).
 */
// Built via new RegExp so the no-control-regex lint (which fires on even
// Unicode-escaped control refs in regex literals) does not reject the pattern.
// oxlint-disable-next-line no-control-regex, eslint/prefer-regex-literals -- control ranges cannot be written as a literal here
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]+", "gu");

/**
 * Strip CR/LF/NUL/control chars before logging or surfacing to remote MTAs.
 * Slice FIRST, then replace: a global replace materializes one part per match.
 */
export const sanitizeForLog = (value: string, maxLen = 200): string =>
  value.slice(0, maxLen).replaceAll(CONTROL_CHARS_RE, " ");

export type MimeFrom =
  | { ok: true; addrSpec: string }
  | { ok: false; reason: "missing" | "multiple" | "malformed" };

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const HTAB = 0x09;
const COLON = 0x3a;

// "from"
const FROM_NAME = [0x66, 0x72, 0x6f, 0x6d];

/**
 * Where the value of the header line `raw[start, end)` begins if the line
 * is named `From` — the byte after its first `:` — or -1 if it is not.
 */
const fromValueStart = (
  raw: Uint8Array,
  start: number,
  end: number
): number => {
  if (end - start <= FROM_NAME.length) {
    return -1;
  }

  for (let i = 0; i < FROM_NAME.length; i += 1) {
    // ASCII case fold: `A`..`Z` → `a`..`z`. Non-letters fold to themselves.
    // oxlint-disable-next-line eslint/no-bitwise -- `| 0x20` is the branchless ASCII fold
    if ((raw[start + i] | 0x20) !== FROM_NAME[i]) {
      return -1;
    }
  }

  let colon = start + FROM_NAME.length;

  while (colon < end && (raw[colon] === SP || raw[colon] === HTAB)) {
    colon += 1;
  }

  return colon < end && raw[colon] === COLON ? colon + 1 : -1;
};

const deletePrefix = async (
  kv: IsrKvNamespace,
  prefix: string
): Promise<number> => {
  let purged = 0;
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- cursor-chained pagination: each page needs the previous cursor
    const page = await kv.list({ cursor, prefix });

    // Keys in a page are independent: delete them concurrently.
    // oxlint-disable-next-line eslint/no-await-in-loop -- page barrier before advancing the cursor
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    purged += page.keys.length;

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return purged;
};

/**
 * Whether an ISR KV key names one of the requested paths. Keys are
 * `<v3-prefix><did>/<host>/<normalized>[#rw=<token>]`; the match is on the
 * normalized path across every deployment id and host found in the scan (a
 * superset of Void's self-host path — over-purging a path only evicts cache).
 */
const isrKeyMatchesPaths = (
  key: string,
  wanted: ReadonlySet<string>
): boolean => {
  if (!key.startsWith(ISR_V3_PREFIX)) {
    return false;
  }

  const tail = key.slice(ISR_V3_PREFIX.length);
  const didSlash = tail.indexOf("/");

  if (didSlash === -1) {
    return false;
  }

  const hostSlash = tail.indexOf("/", didSlash + 1);

  if (hostSlash === -1) {
    return false;
  }

  const keyPath = tail.slice(hostSlash + 1);

  if (keyPath.length === 0) {
    return false;
  }

  return wanted.has(splitIsrCacheKey(keyPath).normalizedPath);
};

const handleRevalidate = async (
  env: Env,
  body: Record<string, unknown>
): Promise<Response> => {
  const kv = env.ISR_CACHE;

  if (!kv) {
    return json({ error: "isr cache not configured" }, 502);
  }

  const all = body.all === true;
  const pathsRaw = Array.isArray(body.paths) ? body.paths : [];

  const wanted = new Set(
    pathsRaw
      .filter((p): p is string => typeof p === "string")
      .map(normalizeIsrPath)
  );

  if (!all && wanted.size === 0) {
    return json({ ok: true, purged: 0 });
  }

  try {
    let purged = 0;

    if (all) {
      purged += await deletePrefix(kv, ISR_V3_PREFIX);
      purged += await deletePrefix(kv, ISR_HOST_REGISTRY_PREFIX);
    } else {
      let cursor: string | undefined;

      do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- cursor-chained pagination: each page needs the previous cursor
        const page = await kv.list({ cursor, prefix: ISR_V3_PREFIX });

        const matched = page.keys.filter((key) =>
          isrKeyMatchesPaths(key.name, wanted)
        );

        // Matched keys are independent: delete them concurrently.
        // oxlint-disable-next-line eslint/no-await-in-loop -- page barrier before advancing the cursor
        await Promise.all(matched.map((key) => kv.delete(key.name)));
        purged += matched.length;

        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }

    return json({ ok: true, purged });
  } catch (error) {
    // The runtime throws unless the response is 2xx — fail loudly, never silently.
    return json(
      { error: `revalidation failed: ${sanitizeForLog(errorMessage(error))}` },
      502
    );
  }
};

// ---------------------------------------------------------------------------
// Email validation — ported from Void `platform/packages/proxy/src/email.ts`
// ---------------------------------------------------------------------------

const BUILTIN_MIME_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
]);

/** Bound only app-defined top-level fields, including folded continuation lines. */
const customMimeHeaderBytesWithinLimit = (raw: Uint8Array): boolean => {
  let used = 0;
  let custom = false;

  for (let start = 0; start < raw.byteLength;) {
    let end = start;

    while (end < raw.byteLength && raw[end] !== 10) {
      end += 1;
    }

    const lineEnd = end > start && raw[end - 1] === 13 ? end - 1 : end;

    if (lineEnd === start) {
      return true;
    }

    if (raw[start] !== 32 && raw[start] !== 9) {
      let colon = start;

      while (colon < lineEnd && raw[colon] !== 58) {
        colon += 1;
      }

      const name = new TextDecoder()
        .decode(raw.subarray(start, colon))
        .toLowerCase();

      custom = colon < lineEnd && !BUILTIN_MIME_HEADERS.has(name);
    }

    if (custom) {
      used += lineEnd - start + 2;

      if (used > MAX_CUSTOM_HEADER_BYTES) {
        return false;
      }
    }

    start = end + 1;
  }

  return true;
};

/**
 * The operator mail domain for this environment, mirrored into deployed apps as
 * the `__VOID_EMAIL_DOMAIN` plain-text binding so the framework builds its
 * default `from` against the same zone. There is deliberately NO baked-in
 * default: missing configuration fails the send CLOSED.
 */
const readSenderDomain = (env: Env): string | null => {
  const raw = env.__VOID_EMAIL_DOMAIN;

  if (typeof raw !== "string") {
    return null;
  }

  const domain = raw.trim().toLowerCase();

  return domain.length > 0 ? domain : null;
};

const RE_METACHARS_RE = /[.*+?^${}()|[\]\\]/gu;

const escapeRegExp = (value: string): string =>
  value.replaceAll(RE_METACHARS_RE, "\\$&");

/**
 * Memoized per-domain sender regexes. Keyed by the configured sender domain,
 * which is worker configuration and not user input.
 */
const strictFromCache = new Map<string, RegExp>();

/**
 * Strict shape for the outbound `from` envelope address: lowercase ASCII
 * local-part, zero or more `+<safe-tag>` segments, then exactly
 * `@<sender domain>`. Pins the entire string so CR/LF, quotes, angle brackets
 * and display-name forms can never reach the SMTP envelope. The domain is
 * escaped before interpolation so a misconfigured value can never widen the
 * pattern.
 */
const strictFromRe = (domain: string): RegExp => {
  const cached = strictFromCache.get(domain);

  if (cached) {
    return cached;
  }

  const re = new RegExp(
    `^[a-z0-9._-]+(?:\\+[a-z0-9._=/-]+)*@${escapeRegExp(domain)}$`,
    "u"
  );

  strictFromCache.set(domain, re);

  return re;
};

/** Operator-readable detail for each way the pin can fail to find a sender. */
const MIME_FROM_REFUSALS: Record<
  Extract<MimeFrom, { ok: false }>["reason"],
  string
> = {
  malformed: "the From header must hold a single mailbox",
  missing: "the message has no From header",
  multiple: "the message has more than one From header",
};

/** Punctuation that can never appear in a single-mailbox header value. */
const FORBIDDEN_MAILBOX_CHARS = new Set([
  ",",
  ";",
  ":",
  "(",
  ")",
  "[",
  "]",
  "\\",
]);

interface MailboxStructure {
  lt: number;
  gt: number;
  firstAt: number;
}

/**
 * One pass over the header value recording bracket/`@` positions.
 * Quoted-strings are skipped whole; `null` on any structural violation.
 */
const scanMailboxStructure = (value: string): MailboxStructure | null => {
  let inQuotes = false;
  let escaped = false;
  let lt = -1;
  let gt = -1;
  let firstAt = -1;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];

    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inQuotes = false;
      }

      continue;
    }

    if (ch === '"') {
      // A quoted-string belongs to the phrase, which ends at `<`.
      if (lt !== -1) {
        return null;
      }

      inQuotes = true;
    } else if (ch === "<") {
      if (lt !== -1) {
        return null;
      }

      lt = i;
    } else if (ch === ">") {
      if (lt === -1 || gt !== -1) {
        return null;
      }

      gt = i;
    } else if (ch === "@") {
      if (firstAt === -1) {
        firstAt = i;
      }
    } else if (FORBIDDEN_MAILBOX_CHARS.has(ch)) {
      return null;
    }
  }

  if (inQuotes) {
    return null;
  }

  return { firstAt, gt, lt };
};

/** Resolve the addr-spec from scanned bracket positions, or `null`. */
const resolveAngleAddrSpec = (
  value: string,
  structure: MailboxStructure
): string | null => {
  const { firstAt, gt, lt } = structure;
  let addrSpec: string;

  if (lt === -1) {
    addrSpec = value.trim();
  } else {
    // `<` present: it needs its `>`, nothing but WSP may follow, and the
    // phrase before it must not read as an address of its own.
    if (gt === -1 || value.slice(gt + 1).trim().length !== 0) {
      return null;
    }

    if (firstAt !== -1 && firstAt < lt) {
      return null;
    }

    addrSpec = value.slice(lt + 1, gt);
  }

  // One printable-ASCII token. Rules out an empty `<>`, WSP inside the
  // brackets, and a code point that only LOOKS like the sender before the
  // caller lower-cases it for the compare.
  return /^[\u0021-\u007E]+$/u.test(addrSpec) ? addrSpec : null;
};

/**
 * The addr-spec of a header value that holds exactly one mailbox — either a
 * bare `addr-spec` or `[phrase] <addr-spec>` — or `null` when the value is
 * anything else. One pass; quoted-strings are skipped whole.
 */
const singleMailboxAddrSpec = (value: string): string | null => {
  const structure = scanMailboxStructure(value);

  if (!structure) {
    return null;
  }

  return resolveAngleAddrSpec(value, structure);
};

/**
 * Unfold a header value range (RFC 5322 §2.2.3): drop CR and LF in place on
 * one copy of the range. A header that did not fold needs no copy.
 */
const unfoldHeaderValue = (
  raw: Uint8Array,
  valueStart: number,
  valueEnd: number,
  folded: boolean
): Uint8Array => {
  if (!folded) {
    return raw.subarray(valueStart, valueEnd);
  }

  const value = raw.slice(valueStart, valueEnd);
  let kept = 0;

  for (const byte of value) {
    if (byte !== CR && byte !== LF) {
      value[kept] = byte;

      kept += 1;
    }
  }

  return value.subarray(0, kept);
};

/**
 * The addr-spec named by the message-level `From:` header, or why there is no
 * single one to name. Exactly one `From:` header holding exactly one mailbox;
 * the scan stops at the first empty line and keeps nothing per line (only the
 * byte offsets of the one `From:` found), so folded headers cannot blow the
 * isolate heap.
 */
export const readMimeFromAddrSpec = (raw: Uint8Array): MimeFrom => {
  const n = raw.byteLength;
  let fromCount = 0;
  let valueStart = -1;
  let valueEnd = -1;
  let folded = false;
  let inFrom = false;
  let nextCr = raw.indexOf(CR);
  let lineStart = 0;

  while (lineStart < n) {
    const lf = raw.indexOf(LF, lineStart);
    const lineEnd = lf === -1 ? n : lf;
    let contentEnd = lineEnd;

    if (contentEnd > lineStart && raw[contentEnd - 1] === CR) {
      contentEnd -= 1;
    }

    if (contentEnd === lineStart) {
      // empty line: end of the header block
      break;
    }

    if (nextCr !== -1 && nextCr < lineStart) {
      nextCr = raw.indexOf(CR, lineStart);
    }

    if (nextCr !== -1 && nextCr < contentEnd) {
      return { ok: false, reason: "malformed" };
    }

    if (raw[lineStart] === SP || raw[lineStart] === HTAB) {
      if (inFrom) {
        valueEnd = contentEnd;
        folded = true;
      }
    } else {
      const start = fromValueStart(raw, lineStart, contentEnd);
      inFrom = start !== -1;

      if (inFrom) {
        fromCount += 1;
        valueStart = start;
        valueEnd = contentEnd;
        folded = false;
      }
    }

    lineStart = lf === -1 ? n : lf + 1;
  }

  if (fromCount === 0) {
    return { ok: false, reason: "missing" };
  }

  if (fromCount > 1) {
    return { ok: false, reason: "multiple" };
  }

  const value = unfoldHeaderValue(raw, valueStart, valueEnd, folded);
  const addrSpec = singleMailboxAddrSpec(new TextDecoder().decode(value));

  return addrSpec === null
    ? { ok: false, reason: "malformed" }
    : { addrSpec, ok: true };
};

/** Refuse a message whose MIME `From:` is not exactly the envelope sender. */
const refuseMimeFromMismatch = (
  raw: Uint8Array,
  from: string
): Response | null => {
  const mimeFrom = readMimeFromAddrSpec(raw);

  if (mimeFrom.ok && mimeFrom.addrSpec.toLowerCase() === from.toLowerCase()) {
    return null;
  }

  const detail = mimeFrom.ok
    ? "the From header address does not match the envelope sender"
    : MIME_FROM_REFUSALS[mimeFrom.reason];

  return json(
    {
      error: {
        code: "INVALID_FROM",
        message: `mime From must be the envelope sender ${from}: ${detail}`,
      },
      ok: false,
    },
    403
  );
};

export class EmailProviderTimeoutError extends Error {
  constructor() {
    super("email provider outcome unknown after timeout");
    this.name = "EmailProviderTimeoutError";
  }
}

/** One absolute batch budget, with a shorter ceiling for each provider submission. */
export const createEmailProviderDeadline = (
  totalMs: number = EMAIL_SEND_DEADLINE_MS
) => {
  const deadline = Date.now() + totalMs;

  return {
    expired(reserveMs = 0): boolean {
      return Date.now() >= deadline - reserveMs;
    },
    remainingMs(reserveMs = 0): number {
      return Math.max(0, deadline - Date.now() - reserveMs);
    },
    async run<T>(submit: () => Promise<T>, reserveMs = 0): Promise<T> {
      const remaining = Math.min(
        EMAIL_PROVIDER_DEADLINE_MS,
        deadline - Date.now() - reserveMs
      );

      if (remaining <= 0) {
        throw new EmailProviderTimeoutError();
      }

      const work = submit();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        return await Promise.race([
          work,
          // oxlint-disable-next-line promise/avoid-new -- timeout leg of the deadline race
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new EmailProviderTimeoutError()),
              remaining
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
};

export type EmailProviderDeadline = ReturnType<
  typeof createEmailProviderDeadline
>;

const base64Decode = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  let offset = 0;

  for (const ch of binary) {
    out[offset] = ch.codePointAt(0) ?? 0;
    offset += 1;
  }

  return out;
};

interface RecipientResult {
  recipient: string;
  ok: boolean;
  state?: string;
  messageId?: string;
  error?: { code: string; message: string };
}

const logSend = (
  projectId: string,
  requestId: string,
  deliveries: RecipientResult[]
): void => {
  for (const d of deliveries) {
    const status = d.ok ? "sent" : (d.error?.code ?? "unknown_error");
    const id = d.messageId ?? "";
    console.log(
      `[email-log] ${projectId} ${requestId} ${sanitizeForLog(d.recipient, 320)} ${status} ${id} @${Date.now()}`
    );
  }
};

// ---------------------------------------------------------------------------
// SMTP client over `cloudflare:sockets` (Noite transport; Void uses the
// `send_email` binding instead).
// ---------------------------------------------------------------------------

type SmtpMode = "starttls" | "implicit" | "plain";

interface SmtpReply {
  code: number;
  /** Full reply text (all lines joined), for `messageId` and diagnostics. */
  text: string;
  /** Upper-cased EHLO extension keywords, for capability checks. */
  extensions: string[];
}

class SmtpError extends Error {
  readonly reply: SmtpReply | null;

  constructor(message: string, reply: SmtpReply | null = null) {
    super(message);
    this.reply = reply;
    this.name = "SmtpError";
  }
}

class SmtpTimeoutError extends Error {
  constructor() {
    super("smtp command timed out");
    this.name = "SmtpTimeoutError";
  }
}

const withTimeout = async <T>(
  ms: number,
  run: () => T | Promise<T>,
  onTimeout: () => Error
): Promise<T> => {
  const work = run();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      // oxlint-disable-next-line promise/avoid-new -- timeout leg of the command race
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/** Line reader over a socket stream with multi-line (250-…) reply parsing. */
class SmtpLineReader {
  private buffer = "";
  private readonly socketReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(socket: ProxySocket) {
    this.socketReader = socket.readable.getReader();
  }

  release(): void {
    this.socketReader.releaseLock();
  }

  async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");

      if (end !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);

        return line;
      }

      if (this.buffer.length > SMTP_MAX_LINE_BYTES) {
        throw new SmtpError("smtp reply line too long");
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read chunk by chunk, in order
      const { value, done } = await this.socketReader.read();

      if (done) {
        throw new SmtpError("smtp connection closed by the server");
      }

      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    let code = -1;

    for (let i = 0; i < SMTP_MAX_REPLY_LINES; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- multi-line replies arrive in order
      const line = await this.readLine();
      lines.push(line);
      const match = /^(?<code>\d{3})(?<sep>[ -])/u.exec(line);

      if (!match?.groups) {
        throw new SmtpError(
          `malformed smtp reply: ${sanitizeForLog(line, 80)}`
        );
      }

      const { code: codeText, sep } = match.groups;
      code = Number(codeText);

      if (sep === " ") {
        return {
          code,
          extensions: lines
            .slice(1)
            .map((l) => l.slice(4).trim().toUpperCase()),
          text: lines.join("\n"),
        };
      }
    }

    throw new SmtpError("smtp reply has too many lines");
  }
}

const base64Encode = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary);
};

/**
 * Dot-stuff raw MIME for the DATA phase: every line starting with `.` gains an
 * extra dot, lines are normalized to CRLF, and the output ends with CRLF so
 * the terminating `.` line can follow.
 */
const dotStuffForSmtp = (raw: Uint8Array): Uint8Array => {
  const text = new TextDecoder("latin1").decode(raw);
  const lines = text.split("\n");
  const stuffed: string[] = [];

  for (let line of lines) {
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    stuffed.push(line.startsWith(".") ? `.${line}` : line);
  }

  return encoder.encode(`${stuffed.join("\r\n")}\r\n`);
};

export interface SmtpSubmitInput {
  connect: SocketConnect;
  host: string;
  port: number;
  mode: SmtpMode;
  username: string | null;
  password: string;
  ehloName: string;
  from: string;
  recipients: string[];
  raw: Uint8Array;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
}

export type SmtpRecipientOutcome =
  | { ok: true; messageId: string }
  | {
      ok: false;
      state: "failed" | "outcome_unknown";
      code: string;
      message: string;
    };

const smtpFailureText = (err: unknown, fallback: string): string => {
  if (err instanceof SmtpTimeoutError) {
    return "smtp request timed out";
  }

  if (err instanceof SmtpError) {
    return err.reply
      ? sanitizeForLog(err.reply.text, SMTP_REPLY_TEXT_MAX_CHARS)
      : sanitizeForLog(err.message, SMTP_REPLY_TEXT_MAX_CHARS);
  }

  return (
    sanitizeForLog(errorMessage(err), SMTP_REPLY_TEXT_MAX_CHARS) || fallback
  );
};

/** AUTH PLAIN, then AUTH LOGIN. Returns true on `235`. */
const smtpAuth = async (
  command: (
    line: string | null,
    expect: (code: number) => boolean
  ) => Promise<SmtpReply>,
  extensions: string[],
  username: string,
  password: string
): Promise<boolean> => {
  const authLine = extensions.find(
    (e) => e === "AUTH" || e.startsWith("AUTH ")
  );

  const mechanisms = authLine ? authLine.slice(4).trim().split(/\s+/u) : [];

  const offers = (mech: string): boolean =>
    mechanisms.length === 0 || mechanisms.includes(mech);

  if (offers("PLAIN")) {
    const initial = base64Encode(encoder.encode(`\0${username}\0${password}`));

    try {
      await command(`AUTH PLAIN ${initial}`, (code) => code === 235);

      return true;
    } catch (error) {
      // Some servers reject the initial response but accept the challenge flow.
      if (!(error instanceof SmtpError) || error.reply === null) {
        throw error;
      }

      if (error.reply.code === 334) {
        try {
          await command(initial, (code) => code === 235);

          return true;
        } catch {
          // Fall through to LOGIN below.
        }
      } else {
        // Fall through to LOGIN below.
      }
    }
  }

  if (offers("LOGIN")) {
    try {
      await command("AUTH LOGIN", (code) => code === 334);
      await command(
        base64Encode(encoder.encode(username)),
        (code) => code === 334
      );
      await command(
        base64Encode(encoder.encode(password)),
        (code) => code === 235
      );

      return true;
    } catch {
      return false;
    }
  }

  return false;
};

/**
 * Submit one message in a single SMTP transaction. Returns a per-recipient
 * outcome for every recipient. Throws only on internal misuse; transport
 * failures become per-recipient `failed`/`outcome_unknown` outcomes.
 */
export const smtpSubmit = async (
  input: SmtpSubmitInput
): Promise<Map<string, SmtpRecipientOutcome>> => {
  const outcomes = new Map<string, SmtpRecipientOutcome>();

  const failAll = (
    state: "failed" | "outcome_unknown",
    code: string,
    message: string
  ): void => {
    for (const r of input.recipients) {
      if (!outcomes.has(r)) {
        outcomes.set(r, { code, message, ok: false, state });
      }
    }
  };

  let socket: ProxySocket | null = null;
  let reader: SmtpLineReader | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  try {
    socket = await withTimeout(
      input.connectTimeoutMs,
      () =>
        input.connect(
          { hostname: input.host, port: input.port },
          { secureTransport: input.mode === "implicit" ? "on" : "off" }
        ),
      () => new SmtpTimeoutError()
    );
    // NOTE: `starttls` mode connects plaintext here and upgrades after the
    // STARTTLS command below (celld exposes the upgrade via `startTls()`).
    writer = socket.writable.getWriter();
    reader = new SmtpLineReader(socket);

    const command = (
      line: string | null,
      expect: (code: number) => boolean
    ): Promise<SmtpReply> =>
      withTimeout(
        input.commandTimeoutMs,
        async () => {
          const activeWriter = writer;
          const activeReader = reader;

          if (activeWriter === null || activeReader === null) {
            throw new SmtpError("smtp connection closed");
          }

          if (line !== null) {
            await activeWriter.write(encoder.encode(`${line}\r\n`));
          }

          const reply = await activeReader.readReply();

          if (!expect(reply.code)) {
            throw new SmtpError(
              `smtp command failed: ${sanitizeForLog(reply.text, 120)}`,
              reply
            );
          }

          return reply;
        },
        () => new SmtpTimeoutError()
      );

    await command(null, (code) => code === 220);

    const greetingEhlo = await command(
      `EHLO ${input.ehloName}`,
      (code) => code === 250
    );

    const maybeUpgradeToTls = async (
      plainEhlo: SmtpReply
    ): Promise<SmtpReply | null> => {
      if (input.mode !== "starttls") {
        return plainEhlo;
      }

      if (
        !plainEhlo.extensions.some(
          (e) => e === "STARTTLS" || e.startsWith("STARTTLS ")
        )
      ) {
        failAll(
          "failed",
          "UPSTREAM_ERROR",
          "smtp server does not offer STARTTLS"
        );

        return null;
      }

      await command("STARTTLS", (code) => code === 220);
      const plainSocket = socket;
      const plainReader = reader;
      const plainWriter = writer;

      if (!plainSocket) {
        throw new SmtpError("smtp connection closed");
      }

      if (plainReader) {
        plainReader.release();
      }

      if (plainWriter) {
        await plainWriter.close().catch(() => null);
      }

      socket = plainSocket.startTls({ expectedServerHostname: input.host });
      writer = socket.writable.getWriter();
      reader = new SmtpLineReader(socket);

      return command(`EHLO ${input.ehloName}`, (code) => code === 250);
    };

    const ehlo = await maybeUpgradeToTls(greetingEhlo);

    if (!ehlo) {
      return outcomes;
    }

    if (input.username !== null) {
      const authed = await smtpAuth(
        command,
        ehlo.extensions,
        input.username,
        input.password
      ).catch(() => false);

      if (!authed) {
        failAll("failed", "UPSTREAM_ERROR", "smtp authentication failed");

        return outcomes;
      }
    }

    try {
      await command(`MAIL FROM:<${input.from}>`, (code) => code === 250);
    } catch (error) {
      failAll(
        "failed",
        "UPSTREAM_ERROR",
        smtpFailureText(error, "smtp MAIL FROM rejected")
      );

      return outcomes;
    }

    const accepted: string[] = [];

    for (const recipient of input.recipients) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- SMTP is lock-step: one RCPT per round trip
        await command(
          `RCPT TO:<${recipient}>`,
          (code) => code === 250 || code === 251
        );
        accepted.push(recipient);
      } catch (error) {
        const reply = error instanceof SmtpError ? error.reply : null;
        // 5xx is permanent (bad destination); 4xx is transient (server policy).
        const permanent = reply === null || reply.code >= 500;
        outcomes.set(recipient, {
          code: permanent ? "UNVERIFIED_DESTINATION" : "UPSTREAM_ERROR",
          message: smtpFailureText(error, `recipient '${recipient}' rejected`),
          ok: false,
          state: "failed",
        });
      }
    }

    if (accepted.length === 0) {
      return outcomes;
    }

    const runDataPhase = async (): Promise<void> => {
      try {
        await command("DATA", (code) => code === 354);
      } catch (error) {
        for (const r of accepted) {
          outcomes.set(r, {
            code: "UPSTREAM_ERROR",
            message: smtpFailureText(error, "smtp DATA rejected"),
            ok: false,
            state: "failed",
          });
        }

        return;
      }

      try {
        // Once the DATA bytes leave, a timeout or disconnect means the server
        // may have queued the message — see the `outcome_unknown` catch below.
        const endReply = await withTimeout(
          input.commandTimeoutMs,
          async () => {
            const activeWriter = writer;
            const activeReader = reader;

            if (activeWriter === null || activeReader === null) {
              throw new SmtpError("smtp connection closed");
            }

            await activeWriter.write(dotStuffForSmtp(input.raw));
            await activeWriter.write(encoder.encode(".\r\n"));

            return activeReader.readReply();
          },
          () => new SmtpTimeoutError()
        );

        if (endReply.code !== 250) {
          for (const r of accepted) {
            outcomes.set(r, {
              code: "UPSTREAM_ERROR",
              message: `smtp DATA refused: ${sanitizeForLog(endReply.text, SMTP_REPLY_TEXT_MAX_CHARS)}`,
              ok: false,
              state: "failed",
            });
          }

          return;
        }

        const messageId = sanitizeForLog(
          endReply.text,
          SMTP_MESSAGE_ID_MAX_CHARS
        );

        for (const r of accepted) {
          outcomes.set(r, { messageId, ok: true });
        }
      } catch {
        // Timeout or disconnect after the bytes left: the server may have
        // queued the message. Never report a silent success or a definite
        // failure.
        for (const r of accepted) {
          outcomes.set(r, {
            code: "OUTCOME_UNKNOWN",
            message:
              "provider outcome unknown; inspect email logs before retrying",
            ok: false,
            state: "outcome_unknown",
          });
        }
      }
    };

    await runDataPhase();

    return outcomes;
  } catch (error) {
    // Pre-DATA failures (connect, greeting, EHLO, TLS, MAIL): nothing was
    // accepted, so `failed` is accurate.
    failAll(
      "failed",
      "UPSTREAM_ERROR",
      smtpFailureText(error, "smtp submission failed")
    );

    return outcomes;
  } finally {
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        // Already closed by the STARTTLS upgrade path.
      }
    }

    if (reader) {
      try {
        reader.release();
      } catch {
        // Already released by the STARTTLS upgrade path.
      }
    }

    if (socket) {
      try {
        const quitWriter = socket.writable.getWriter();
        await quitWriter.write(encoder.encode("QUIT\r\n")).catch(() => null);
        quitWriter.releaseLock();
      } catch {
        // Best effort on a broken connection.
      }

      await socket.close().catch(() => null);
    }
  }
};

// ---------------------------------------------------------------------------
// POST /email/send
// ---------------------------------------------------------------------------

type AllowEntry =
  | { type: "exact"; value: string }
  | { type: "domain"; value: string };

const parseAllowlist = (raw: string | undefined): AllowEntry[] => {
  if (!raw) {
    return [];
  }

  const entries: AllowEntry[] = [];

  for (const part of raw.split(/[\s,]+/u)) {
    const entry = part.trim().toLowerCase();

    if (entry.length === 0) {
      continue;
    }

    if (entry.startsWith("@")) {
      if (entry.length > 1) {
        entries.push({ type: "domain", value: entry });
      }
    } else {
      entries.push({ type: "exact", value: entry });
    }
  }

  return entries;
};

const isAllowlisted = (entries: AllowEntry[], recipient: string): boolean => {
  for (const entry of entries) {
    if (entry.type === "exact") {
      if (recipient === entry.value) {
        return true;
      }
    } else if (recipient.endsWith(entry.value)) {
      return true;
    }
  }

  return false;
};

const emailPayloadDigest = async (
  from: string,
  recipients: string[],
  mimeBase64: string
): Promise<string> => {
  // Noite-defined (no interop with Void's digest needed): unit separators can
  // never appear in the lower-cased ASCII addresses or the base64 body.
  const material = `${from}${recipients.toSorted().join("")}${mimeBase64}`;
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(material));

  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

interface StoredOutcome {
  digest: string;
  status: number;
  body: unknown;
}

const emailError = (code: string, message: string, status: number): Response =>
  json({ error: { code, message }, ok: false }, status);

const platformSocketConnect = async (): Promise<SocketConnect> => {
  const mod = await import("cloudflare:sockets");

  // SAFETY: the platform module always exports `connect`; ProxySocket is a
  // structural subset of the platform Socket, so any extra members are ignored.
  return mod.connect as SocketConnect;
};

interface SmtpConfig {
  host: string;
  port: number;
  mode: SmtpMode;
  username: string | null;
  password: string;
}

/** Read SMTP config; returns an error message string when misconfigured. */
const readSmtpConfig = (env: Env): SmtpConfig | string => {
  const host = (env.VOID_PROXY_SMTP_HOST ?? "").trim();

  if (!host) {
    return "email sending is not configured";
  }

  const modeRaw = (env.VOID_PROXY_SMTP_MODE ?? "starttls").trim().toLowerCase();

  if (modeRaw !== "starttls" && modeRaw !== "implicit" && modeRaw !== "plain") {
    return `email smtp mode must be starttls, implicit or plain (got ${sanitizeForLog(modeRaw, 32)})`;
  }

  if (modeRaw === "plain" && env.VOID_PROXY_SMTP_ALLOW_PLAINTEXT !== "1") {
    return "email smtp plaintext mode requires the operator plaintext allowance";
  }

  let defaultPort = 25;

  if (modeRaw === "implicit") {
    defaultPort = 465;
  } else if (modeRaw === "starttls") {
    defaultPort = 587;
  }

  const portRaw = (env.VOID_PROXY_SMTP_PORT ?? "").trim();
  let port = defaultPort;

  if (portRaw !== "") {
    if (!/^\d+$/u.test(portRaw)) {
      return "email smtp port is invalid";
    }

    port = Number(portRaw);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return "email smtp port is invalid";
    }
  }

  const usernameRaw = env.VOID_PROXY_SMTP_USERNAME;

  const username =
    typeof usernameRaw === "string" && usernameRaw.length > 0
      ? usernameRaw
      : null;

  const password =
    typeof env.VOID_PROXY_SMTP_PASSWORD === "string"
      ? env.VOID_PROXY_SMTP_PASSWORD
      : "";

  return { host, mode: modeRaw, password, port, username };
};

const finishEmailSend = async (
  mailKv: MailKvNamespace,
  idempotencyKey: string,
  digest: string,
  projectId: string,
  requestId: string,
  deliveries: RecipientResult[]
): Promise<Response> => {
  const operationId = crypto.randomUUID();
  const anyFailed = deliveries.some((d) => !d.ok);

  const body: unknown = anyFailed
    ? { deliveries, ok: false, operationId }
    : {
        ids: deliveries.map((d) => ({
          messageId: d.messageId ?? "",
          recipient: d.recipient,
          state: "provider_accepted",
        })),
        ok: true,
        operationId,
      };

  logSend(projectId, requestId, deliveries);
  // Best-effort store: a KV failure here must not turn an accepted send into
  // an error (a repeat may double-send — the documented at-least-once limit).
  await mailKv
    .put(
      idempotencyKey,
      JSON.stringify({ body, digest, status: 200 } satisfies StoredOutcome),
      {
        expirationTtl: IDEMPOTENCY_TTL_SECONDS,
      }
    )
    .catch(() => null);

  return json(body, 200);
};

interface ValidatedEmailRequest {
  fromLower: string;
  mimeBase64: string;
  raw: Uint8Array;
  recipients: string[];
  requestId: string;
  operationKey: string;
  senderDomain: string;
  mailKv: MailKvNamespace;
}

/** Normalize and dedupe recipients, or the refusal to return. */
const normalizeEmailRecipients = (
  recipientsRaw: unknown[]
): { recipients: string[] } | { response: Response } => {
  const recipients: string[] = [];
  const seen = new Set<string>();

  for (const r of recipientsRaw) {
    if (typeof r !== "string") {
      continue;
    }

    // Before `.trim().toLowerCase()` — that call is the allocation.
    if (r.length > MAX_RECIPIENT_LENGTH) {
      return {
        response: emailError(
          "INVALID_TO",
          `recipient exceeds ${MAX_RECIPIENT_LENGTH} characters`,
          413
        ),
      };
    }

    const lower = r.trim().toLowerCase();

    if (!lower || seen.has(lower)) {
      continue;
    }

    seen.add(lower);
    recipients.push(lower);
  }

  if (recipients.length === 0) {
    return { response: emailError("INVALID_TO", "no recipients", 200) };
  }

  return { recipients };
};

/** Decode and bound the MIME payload, or the refusal to return. */
const validateEmailMime = (
  mimeBase64: string
): { raw: Uint8Array } | { response: Response } => {
  // Pre-decode size guard — base64 expands ~4/3, so a base64 string longer
  // than `MAX_MIME_BYTES * 4 / 3 + 4` can't decode within the limit. Reject
  // before allocating for what we'd reject anyway.
  if (mimeBase64.length > Math.ceil((MAX_MIME_BYTES * 4) / 3) + 4) {
    return {
      response: emailError(
        "MIME_ERROR",
        `mime exceeds ${MAX_MIME_BYTES} bytes (base64 length ${mimeBase64.length})`,
        413
      ),
    };
  }

  let raw: Uint8Array;

  try {
    raw = base64Decode(mimeBase64);
  } catch {
    return { response: emailError("MIME_ERROR", "invalid base64 mime", 400) };
  }

  if (raw.byteLength > MAX_MIME_BYTES) {
    return {
      response: emailError(
        "MIME_ERROR",
        `mime exceeds ${MAX_MIME_BYTES} bytes (got ${raw.byteLength})`,
        413
      ),
    };
  }

  if (!customMimeHeaderBytesWithinLimit(raw)) {
    return {
      response: emailError(
        "MIME_ERROR",
        "custom headers exceed the 16 KiB limit",
        413
      ),
    };
  }

  return { raw };
};

/** Pin the envelope sender to `<slug>[+tag]@<domain>`, or the refusal. */
const validateEmailSender = (
  env: Env,
  from: string,
  senderDomain: string
): { fromLower: string } | { response: Response } => {
  // Noite has no custom-domain `send_raw` path in v1: the sender must be on the
  // configured domain.
  const fromAt = from.indexOf("@");
  const fromDomain = fromAt === -1 ? "" : from.slice(fromAt + 1).toLowerCase();

  if (fromDomain !== "" && fromDomain !== senderDomain) {
    return {
      response: emailError(
        "INVALID_FROM",
        `from address must use the configured domain ${senderDomain}`,
        200
      ),
    };
  }

  // The envelope is forwarded verbatim, so validation has to run on bytes that
  // cannot change under case folding (U+212A lowercases to 'k'). Refuse
  // non-ASCII before that.
  if (!/^[\u0021-\u007E]+$/u.test(from)) {
    return {
      response: emailError(
        "INVALID_FROM",
        "from address must be printable ASCII",
        403
      ),
    };
  }

  // Sender ownership: Void checks this against PostgreSQL in admission; Noite
  // pins the local part to the app slug the runner injected. Without the pin,
  // one tenant could send as another tenant's sender on the shared domain.
  const slugRaw = env.__VOID_PROJECT_SLUG;
  const slug = typeof slugRaw === "string" ? slugRaw.trim().toLowerCase() : "";

  if (!slug) {
    return {
      response: emailError(
        "UPSTREAM_ERROR",
        "email sender identity is not configured",
        502
      ),
    };
  }

  const fromLower = from.toLowerCase();

  if (!strictFromRe(senderDomain).test(fromLower)) {
    return {
      response: emailError(
        "INVALID_FROM",
        `from address must be <${slug}>[+tag]@${senderDomain}`,
        200
      ),
    };
  }

  const fromLocal = fromLower.slice(0, fromLower.indexOf("@"));
  const localPrefix = fromLocal.split("+")[0] ?? "";

  if (localPrefix !== slug) {
    return {
      response: emailError(
        "INVALID_FROM",
        `from address must be <${slug}>[+tag]@${senderDomain}`,
        200
      ),
    };
  }

  return { fromLower };
};

/** Derive the idempotency operation key, or the refusal response to return. */
const resolveOperationKey = (
  body: Record<string, unknown>
): { operationKey: string; requestId: string } | { response: Response } => {
  // Bounded and sanitized here, once, so `logSend` never interpolates the raw value.
  const requestIdRaw = asString(body.requestId);

  const requestId =
    requestIdRaw === null
      ? "unknown"
      : sanitizeForLog(requestIdRaw, MAX_REQUEST_ID_LENGTH);

  const callerKey = asString(body.idempotencyKey);

  if (
    callerKey !== null &&
    (callerKey.length === 0 ||
      callerKey.length > 128 ||
      !/^[\u0020-\u007E]+$/u.test(callerKey))
  ) {
    return {
      response: emailError("INVALID_TO", "invalid idempotency key", 400),
    };
  }

  const operationKey =
    callerKey ??
    (requestIdRaw &&
    requestIdRaw.length <= 128 &&
    /^[\u0020-\u007E]+$/u.test(requestIdRaw)
      ? requestIdRaw
      : crypto.randomUUID());

  return { operationKey, requestId };
};

/** Validate the send request envelope, or the refusal response to return. */
const validateEmailRequest = (
  env: Env,
  body: Record<string, unknown>
): ValidatedEmailRequest | Response => {
  const from = asString(body.from);
  const mimeBase64 = asString(body.mimeBase64);
  const keys = resolveOperationKey(body);

  if ("response" in keys) {
    return keys.response;
  }

  const { operationKey, requestId } = keys;
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : null;

  if (!from || !mimeBase64 || !recipientsRaw) {
    return emailError("UPSTREAM_ERROR", "invalid body", 400);
  }

  // Bound the list before the normalization loop below allocates per entry.
  if (recipientsRaw.length > MAX_RECIPIENTS) {
    return emailError(
      "INVALID_TO",
      `too many recipients (max ${MAX_RECIPIENTS}, got ${recipientsRaw.length})`,
      413
    );
  }

  // Bound the sender before anything copies it.
  if (from.length > MAX_SENDER_LENGTH) {
    return emailError(
      "INVALID_FROM",
      `sender exceeds ${MAX_SENDER_LENGTH} characters`,
      413
    );
  }

  // Fail closed on missing sender configuration before admission.
  const senderDomain = readSenderDomain(env);

  if (!senderDomain) {
    return emailError(
      "UPSTREAM_ERROR",
      "email sender domain is not configured",
      502
    );
  }

  const normalized = normalizeEmailRecipients(recipientsRaw);

  if ("response" in normalized) {
    return normalized.response;
  }

  const mime = validateEmailMime(mimeBase64);

  if ("response" in mime) {
    return mime.response;
  }

  const sender = validateEmailSender(env, from, senderDomain);

  if ("response" in sender) {
    return sender.response;
  }

  // The envelope is pinned; now pin what the recipient will actually SEE.
  const mimeFromRefusal = refuseMimeFromMismatch(mime.raw, from);

  if (mimeFromRefusal) {
    return mimeFromRefusal;
  }

  const mailKv = env.MAIL_IDEMPOTENCY;

  if (!mailKv) {
    return emailError(
      "UPSTREAM_ERROR",
      "email idempotency store is not configured",
      502
    );
  }

  return {
    fromLower: sender.fromLower,
    mailKv,
    mimeBase64,
    operationKey,
    raw: mime.raw,
    recipients: normalized.recipients,
    requestId,
    senderDomain,
  };
};

/** Read a recorded idempotency outcome, or the failure response to return. */
const readStoredOutcome = async (
  mailKv: MailKvNamespace,
  idempotencyKey: string
): Promise<StoredOutcome | null | Response> => {
  try {
    const rawStored = await mailKv.get(idempotencyKey);

    if (rawStored === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(rawStored);

    if (
      isRecord(parsed) &&
      typeof parsed.digest === "string" &&
      typeof parsed.status === "number" &&
      "body" in parsed
    ) {
      return {
        body: parsed.body,
        digest: parsed.digest,
        status: parsed.status,
      };
    }

    return null;
  } catch {
    return emailError("UPSTREAM_ERROR", "email admission unavailable", 503);
  }
};

interface AdmittedSubmission {
  submit: Map<string, SmtpRecipientOutcome> | null;
  batchExpired: boolean;
}

/** Submit admitted recipients within the batch deadline (null config = refusal). */
const submitAdmittedEmail = async (
  env: Env,
  validated: ValidatedEmailRequest,
  admitted: ReadonlySet<string>,
  sendDeadline: EmailProviderDeadline,
  deps: ProxyDeps
): Promise<AdmittedSubmission | Response> => {
  let submit: Map<string, SmtpRecipientOutcome> | null = null;
  let batchExpired = false;

  if (admitted.size === 0) {
    return { batchExpired, submit };
  }

  const smtpConfig = readSmtpConfig(env);

  if (typeof smtpConfig === "string") {
    return emailError("UPSTREAM_ERROR", smtpConfig, 502);
  }

  try {
    submit = await sendDeadline.run(
      async () =>
        smtpSubmit({
          commandTimeoutMs:
            deps.timeouts?.smtpCommandMs ?? SMTP_COMMAND_TIMEOUT_MS,
          connect: deps.connectSocket ?? (await platformSocketConnect()),
          connectTimeoutMs:
            deps.timeouts?.smtpConnectMs ?? SMTP_CONNECT_TIMEOUT_MS,
          ehloName: validated.senderDomain,
          from: validated.fromLower,
          host: smtpConfig.host,
          mode: smtpConfig.mode,
          password: smtpConfig.password,
          port: smtpConfig.port,
          raw: validated.raw,
          recipients: [...admitted],
          username: smtpConfig.username,
        }),
      EMAIL_SEND_FINALIZATION_MARGIN_MS
    );
  } catch {
    // Overall batch deadline elapsed: submissions may be in flight, so every
    // admitted recipient is unresolved.
    batchExpired = true;
  }

  return { batchExpired, submit };
};

const handleEmailSend = async (
  env: Env,
  body: Record<string, unknown>,
  projectId: string,
  deps: ProxyDeps
): Promise<Response> => {
  const sendDeadline = createEmailProviderDeadline(
    deps.timeouts?.emailTotalMs ?? EMAIL_SEND_DEADLINE_MS
  );

  const validated = validateEmailRequest(env, body);

  if (validated instanceof Response) {
    return validated;
  }

  const digest = await emailPayloadDigest(
    validated.fromLower,
    validated.recipients,
    validated.mimeBase64
  );

  const idempotencyKey = `${IDEMPOTENCY_KEY_PREFIX}${validated.operationKey}`;
  const stored = await readStoredOutcome(validated.mailKv, idempotencyKey);

  if (stored instanceof Response) {
    return stored;
  }

  if (stored) {
    if (stored.digest !== digest) {
      return emailError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key has different content",
        409
      );
    }

    return json(stored.body, stored.status);
  }

  // Admission (replaces Void's SQL admission): operator allowlist of exact
  // addresses and/or `@domain` suffixes. Empty allowlist = fail closed.
  // Non-admitted recipients ride the partial-deliveries shape so one bad
  // address does not fail admitted ones.
  const allowlist = parseAllowlist(env.VOID_PROXY_EMAIL_ALLOWLIST);

  const admitted = new Set(
    validated.recipients.filter((r) => isAllowlisted(allowlist, r))
  );

  const submission = await submitAdmittedEmail(
    env,
    validated,
    admitted,
    sendDeadline,
    deps
  );

  if (submission instanceof Response) {
    return submission;
  }

  const { batchExpired, submit } = submission;

  // One entry per requested recipient, in requested order (the runtime matches
  // them as a set, but ordered output is easier to read and test).
  const deliveries: RecipientResult[] = [];

  for (const recipient of validated.recipients) {
    if (!admitted.has(recipient)) {
      deliveries.push({
        error: {
          code: "UNVERIFIED_DESTINATION",
          message: `recipient '${recipient}' is not allowlisted`,
        },
        ok: false,
        recipient,
        state: "rejected",
      });
      continue;
    }

    const outcome = batchExpired ? null : (submit?.get(recipient) ?? null);

    if (outcome === null) {
      deliveries.push({
        error: {
          code: "OUTCOME_UNKNOWN",
          message:
            "provider outcome unknown; inspect email logs before retrying",
        },
        ok: false,
        recipient,
        state: "outcome_unknown",
      });
    } else if (outcome.ok) {
      deliveries.push({
        messageId: outcome.messageId,
        ok: true,
        recipient,
        state: "provider_accepted",
      });
    } else {
      deliveries.push({
        error: { code: outcome.code, message: outcome.message },
        ok: false,
        recipient,
        state: outcome.state,
      });
    }
  }

  return finishEmailSend(
    validated.mailKv,
    idempotencyKey,
    digest,
    projectId,
    validated.requestId,
    deliveries
  );
};

// ---------------------------------------------------------------------------
// POST /ai/*
// ---------------------------------------------------------------------------

/**
 * Native provider base URLs. Void resolves these through the Cloudflare AI
 * gateway (`AI.gateway(id).getUrl(provider)`); Noite has no gateway, so calls
 * go provider-native. Keys must stay identical to the runtime's
 * `PROVIDER_KEY_MAP` (the runtime rejects unknown providers before sending, so
 * the proxy's own check is defense in depth).
 */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  // Baseten dedicated deployments live on model-specific subdomains; this is
  // the public OpenAI-compatible endpoint for catalog models.
  baseten: "https://inference.baseten.co/v1",
  cartesia: "https://api.cartesia.ai",
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.com/v2",
  deepgram: "https://api.deepgram.com/v1",
  deepseek: "https://api.deepseek.com",
  elevenlabs: "https://api.elevenlabs.io/v1",
  fal: "https://fal.run",
  "google-ai-studio": "https://generativelanguage.googleapis.com/v1beta",
  grok: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  huggingface: "https://router.huggingface.co",
  ideogram: "https://api.ideogram.ai",
  mistral: "https://api.mistral.ai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  parallel: "https://api.parallel.ai",
  perplexity: "https://api.perplexity.ai",
  replicate: "https://api.replicate.com/v1",
};

/**
 * Per-provider auth header/prefix — the runtime's direct-path table (the
 * provider-native conventions), NOT the proxy's single-entry table (Void's
 * proxy calls gateway URLs where Cloudflare normalizes auth). Providers not
 * listed here fall back to `Authorization: Bearer <key>`. A caller's
 * `apiKeyHeader`/`apiKeyPrefix` override still wins.
 */
export const PROVIDER_AUTH_DEFAULTS: Record<
  string,
  { header: string; prefix: string }
> = {
  anthropic: { header: "x-api-key", prefix: "" },
  baseten: { header: "authorization", prefix: "Api-Key " },
  cartesia: { header: "x-api-key", prefix: "" },
  deepgram: { header: "authorization", prefix: "Token " },
  elevenlabs: { header: "xi-api-key", prefix: "" },
  fal: { header: "authorization", prefix: "Key " },
  "google-ai-studio": { header: "x-goog-api-key", prefix: "" },
  ideogram: { header: "Api-Key", prefix: "" },
  parallel: { header: "x-api-key", prefix: "" },
};

const VOID_FILE_MARKER = "__voidFile";

type SerializedFileInput = Readonly<{
  [VOID_FILE_MARKER]: true;
  data: string;
  name?: string;
  type?: string;
}>;

type SerializedProviderBody = Readonly<
  | { type: "none" }
  | { type: "json"; value: unknown }
  | { type: "text"; data: string; contentType?: string }
  | { type: "base64"; data: string; contentType?: string }
  | {
      type: "form";
      entries: { name: string; value: string | SerializedFileInput }[];
    }
>;

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

const isSerializedFileInput = (
  value: unknown
): value is SerializedFileInput => {
  if (!isRecord(value)) {
    return false;
  }

  const marker = value[VOID_FILE_MARKER];
  const { data, name, type } = value;

  return (
    marker === true &&
    typeof data === "string" &&
    (name === undefined || typeof name === "string") &&
    (type === undefined || typeof type === "string")
  );
};

const base64ToBytes = (base64: string): Uint8Array => {
  let binary: string;

  try {
    binary = atob(base64);
  } catch {
    throw new BadRequestError("invalid file data");
  }

  const bytes = new Uint8Array(binary.length);
  let offset = 0;

  for (const ch of binary) {
    bytes[offset] = ch.codePointAt(0) ?? 0;
    offset += 1;
  }

  return bytes;
};

const providerEndpointUrl = (baseUrl: string, endpoint: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint.slice(1)
    : endpoint;

  return `${normalizedBase}/${normalizedEndpoint}`;
};

const isUnsafeProviderPath = (path: string): boolean => {
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(path) || path.includes("\\")) {
    return true;
  }

  const pathname = path.split(/[?#]/u, 1)[0] ?? "";

  for (const segment of pathname.split("/")) {
    try {
      if (decodeURIComponent(segment) === "..") {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
};

const providerBody = (value: unknown): SerializedProviderBody => {
  const record = asRecord(value);
  const type = asString(record.type);

  if (
    type === "none" ||
    type === "json" ||
    type === "text" ||
    type === "base64" ||
    type === "form"
  ) {
    // SAFETY: only the `type` tag is checked; the envelope fields are trusted
    // per the framework's serializer contract, and a malformed envelope throws
    // inside providerRequestBody, which the caller maps to a 502 like Void.
    return record as SerializedProviderBody;
  }

  return { type: "none" };
};

const appendSerializedFormValue = (
  form: FormData,
  name: string,
  value: string | SerializedFileInput
): void => {
  if (isSerializedFileInput(value)) {
    const bytes = base64ToBytes(value.data);

    // SAFETY: exact-length fresh allocation, so `.buffer` holds exactly the file bytes.
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
      type: value.type ?? "application/octet-stream",
    });

    form.append(name, blob, value.name ?? name);

    return;
  }

  form.append(name, value);
};

const providerRequestBody = (
  body: SerializedProviderBody
): {
  body?: BodyInit;
  contentType?: string;
} => {
  if (body.type === "none") {
    return {};
  }

  if (body.type === "json") {
    return {
      body: JSON.stringify(body.value),
      contentType: "application/json",
    };
  }

  if (body.type === "text") {
    return { body: body.data, contentType: body.contentType };
  }

  if (body.type === "base64") {
    const raw = base64ToBytes(body.data);

    // SAFETY: exact-length fresh allocation, so `.buffer` holds exactly the payload bytes.
    return { body: raw.buffer as ArrayBuffer, contentType: body.contentType };
  }

  const form = new FormData();

  for (const entry of body.entries) {
    appendSerializedFormValue(form, entry.name, entry.value);
  }

  return { body: form };
};

const headersFromRecord = (value: unknown): Headers => {
  const headers = new Headers();

  for (const [key, headerValue] of Object.entries(asRecord(value))) {
    if (typeof headerValue === "string") {
      headers.set(key, headerValue);
    }
  }

  return headers;
};

const providerAuthDefaults = (
  provider: string
): {
  header: string;
  prefix: string;
} =>
  PROVIDER_AUTH_DEFAULTS[provider] ?? {
    header: "authorization",
    prefix: "Bearer ",
  };

const applyProviderHeaders = ({
  headers,
  provider,
  providerKey,
  apiKeyHeader,
  apiKeyPrefix,
  contentType,
}: {
  headers: Headers;
  provider: string;
  providerKey: string;
  apiKeyHeader?: string | null;
  apiKeyPrefix?: string | null;
  contentType?: string;
}): Headers => {
  const defaults = providerAuthDefaults(provider);
  const keyHeader = apiKeyHeader ?? defaults.header;
  const keyPrefix = apiKeyPrefix ?? defaults.prefix;

  headers.set(keyHeader, `${keyPrefix}${providerKey}`);

  if (contentType && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }

  return headers;
};

const filteredResponseHeaders = (response: Response): Headers => {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");

  if (contentType) {
    headers.set("content-type", contentType);
  }

  if (cacheControl) {
    headers.set("cache-control", cacheControl);
  }

  return headers;
};

const handleAiProvider = async (
  body: Record<string, unknown>,
  deps: ProxyDeps
): Promise<Response> => {
  const provider = asString(body.provider);
  const path = asString(body.path);
  const method = asString(body.method) ?? "POST";
  const providerKey = asString(body.providerKey);
  const apiKeyHeader = asString(body.apiKeyHeader);
  const apiKeyPrefix = asString(body.apiKeyPrefix);

  if (!provider) {
    return json({ error: "provider required" }, 400);
  }

  if (!path) {
    return json({ error: "path required" }, 400);
  }

  if (!providerKey) {
    return json({ error: "providerKey required" }, 400);
  }

  const baseUrl = PROVIDER_BASE_URLS[provider];

  if (!baseUrl) {
    return json({ error: `unknown provider '${provider}'` }, 400);
  }

  if (isUnsafeProviderPath(path)) {
    return json({ error: "path must be relative" }, 400);
  }

  try {
    const requestBody = providerRequestBody(providerBody(body.body));

    const headers = applyProviderHeaders({
      apiKeyHeader,
      apiKeyPrefix,
      contentType: requestBody.contentType,
      headers: headersFromRecord(body.headers),
      provider,
      providerKey,
    });

    const upstream = deps.fetchUpstream ?? fetch;

    const response = await upstream(providerEndpointUrl(baseUrl, path), {
      body: requestBody.body,
      headers,
      method,
    });

    if (!response.ok) {
      const text = await response.text();
      let error: string;

      try {
        const parsed: unknown = JSON.parse(text);
        error =
          isRecord(parsed) &&
          isRecord(parsed.error) &&
          typeof parsed.error.message === "string"
            ? parsed.error.message
            : text;
      } catch {
        error = text;
      }

      const status =
        Number.isInteger(response.status) &&
        response.status >= 400 &&
        response.status <= 599
          ? response.status
          : 502;

      return json({ error }, status);
    }

    // Byte passthrough (streams SSE frames untouched).
    return new Response(response.body, {
      headers: filteredResponseHeaders(response),
      status: response.status,
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json({ error: error.message }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("AI provider error:", message);

    return json({ error: "upstream error" }, 502);
  }
};

interface AiModelMapping {
  endpoint: string;
  model: string;
}

const readAiModelMap = (env: Env): Record<string, AiModelMapping> | null => {
  const raw = (env.VOID_PROXY_AI_MODELS ?? "").trim();

  if (!raw) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const map: Record<string, AiModelMapping> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (
      isRecord(value) &&
      typeof value.endpoint === "string" &&
      typeof value.model === "string"
    ) {
      map[key] = { endpoint: value.endpoint, model: value.model };
    }
  }

  return map;
};

const handleAiRun = async (
  env: Env,
  body: Record<string, unknown>,
  deps: ProxyDeps
): Promise<Response> => {
  const model = asString(body.model);

  if (!model) {
    return json({ error: "model required" }, 400);
  }

  const map = readAiModelMap(env);

  if (map === null) {
    return json({ error: "ai model map invalid" }, 502);
  }

  const mapping = map[model];

  if (!mapping) {
    // Loud, never a silent substitute.
    return json({ error: "model not available", model }, 501);
  }

  const inputs = asRecord(body.inputs);

  if (!Array.isArray(inputs.messages)) {
    return json(
      {
        error: "model input not supported",
        message:
          "Noite /ai/run supports chat inputs ({ messages: [...] }) only; this model input has another task shape.",
      },
      501
    );
  }

  const stream = inputs.stream === true;

  const endpoint = mapping.endpoint.endsWith("/")
    ? mapping.endpoint.slice(0, -1)
    : mapping.endpoint;

  const headers = new Headers({ "content-type": "application/json" });
  const apiKey = env.VOID_PROXY_AI_API_KEY;

  if (typeof apiKey === "string" && apiKey.length > 0) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  try {
    const upstream = deps.fetchUpstream ?? fetch;

    const response = await upstream(`${endpoint}/chat/completions`, {
      body: JSON.stringify({ ...inputs, model: mapping.model }),
      headers,
      method: "POST",
    });

    if (stream && response.body) {
      return new Response(response.body, {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
      });
    }

    // Endpoint-native shape (documented, not translated to Workers AI shapes).
    return new Response(response.body, {
      headers: filteredResponseHeaders(response),
      status: response.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("AI run error:", message);

    return json({ error: "upstream error" }, 502);
  }
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const POST_ROUTES = new Set([
  "/revalidate",
  "/email/send",
  "/email/relay",
  "/ai/run",
  "/ai/provider",
  "/ai/models",
  "/ai/toMarkdown",
]);

const handleHealth = (env: Env): Response => {
  const smtpHost = (env.VOID_PROXY_SMTP_HOST ?? "").trim();

  return json({
    bindings: {
      ai: env.VOID_PROXY_AI_ENABLED === "1",
      aiRun:
        readAiModelMap(env) !== null &&
        Object.keys(readAiModelMap(env) ?? {}).length > 0,
      email: smtpHost.length > 0,
      emailDomain: readSenderDomain(env) !== null,
      isrCache: !!env.ISR_CACHE,
      mailKv: !!env.MAIL_IDEMPOTENCY,
    },
    ok: true,
  });
};

/**
 * Service-binding auth only (the proxy is not publicly routable, so Void's
 * JWT/HTTPS path is dropped): per-fleet token equality plus a `projectId` pin
 * against the proxy's own configured id. The token is tenant-visible, which is
 * harmless — isolation comes from the transport (service bindings resolve only
 * within the fleet process), not from the token.
 */
const authenticateProxyRequest = (
  env: Env,
  body: Record<string, unknown>
): { projectId: string } | { response: Response } => {
  const projectId = asString(body.projectId);
  const aiToken = asString(body.aiToken);

  if (!projectId || !aiToken) {
    return { response: json({ error: "projectId and aiToken required" }, 400) };
  }

  const expectedProjectId = env.__PROJECT_ID;
  const expectedToken = env.__VOID_PROXY_TOKEN;

  if (!expectedProjectId || !expectedToken) {
    return { response: json({ error: "proxy not configured" }, 500) };
  }

  if (
    projectId !== expectedProjectId ||
    !timingSafeEqual(aiToken, expectedToken)
  ) {
    return { response: json({ error: "invalid project token" }, 403) };
  }

  return { projectId };
};

/**
 * Proxy entry point. `deps` injects the platform edges (sockets, upstream
 * fetch, timeouts) for tests; production passes none.
 */
export const handleFetch = async (
  request: Request,
  env: Env,
  deps: ProxyDeps = {}
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    return handleHealth(env);
  }

  if (!POST_ROUTES.has(path)) {
    return json({ error: "not found" }, 404);
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // The former relay endpoint is gone. Reject it before auth so an untrusted
  // MIME stream is never parsed or buffered here.
  if (path === "/email/relay") {
    return json({ error: "not found" }, 404);
  }

  let parsed: unknown;

  try {
    parsed = await readRequestJson(request, requestBodyMaxBytes(path));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: "invalid JSON body" }, 400);
  }

  if (!isRecord(parsed)) {
    return json({ error: "invalid JSON body" }, 400);
  }

  const body = parsed;
  const auth = authenticateProxyRequest(env, body);

  if ("response" in auth) {
    return auth.response;
  }

  const { projectId } = auth;

  // Per-group capability gates.
  if (path.startsWith("/email/")) {
    if ((env.VOID_PROXY_SMTP_HOST ?? "").trim().length === 0) {
      return json({ error: "email not configured" }, 501);
    }

    return handleEmailSend(env, body, projectId, deps);
  }

  if (path.startsWith("/ai/")) {
    if (env.VOID_PROXY_AI_ENABLED !== "1") {
      return json({ error: "ai not configured" }, 501);
    }

    switch (path) {
      case "/ai/provider": {
        return handleAiProvider(body, deps);
      }

      case "/ai/run": {
        return handleAiRun(env, body, deps);
      }

      case "/ai/models":
      case "/ai/toMarkdown": {
        return json(
          {
            error: "not available",
            message:
              "This operation requires the Workers AI binding, which Noite does not provide.",
          },
          501
        );
      }

      default: {
        return json({ error: "not found" }, 404);
      }
    }
  }

  return handleRevalidate(env, body);
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
};
