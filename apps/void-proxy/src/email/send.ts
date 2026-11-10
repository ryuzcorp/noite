/**
 * `POST /email/send` (Void's response contract verbatim): allowlist admission,
 * KV idempotency, and SMTP submission.
 *
 * The request is one machine; the wire shapes are unchanged:
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> Validate
 *     Validate --> Refused: first refusal wins (one status table)
 *     Validate --> Lookup: valid envelope
 *     Lookup --> Replayed: stored digest matches
 *     Lookup --> Conflict: stored digest differs (409)
 *     Lookup --> Unavailable: KV read failed (503)
 *     Lookup --> Admit: no record
 *     Admit --> Submit: allowlist partitions recipients
 *     Submit --> Refused: relay unconfigured / misconfigured
 *     Submit --> Outcome: one delivery per requested recipient
 *     Outcome --> Record: Accepted / Partial
 *     Outcome --> [*]: Failed / Unknown (nothing recorded)
 *     Record --> [*]: deliveries + operationId
 *     Refused --> [*]
 *     Replayed --> [*]
 *     Conflict --> [*]
 *     Unavailable --> [*]
 * ```
 *
 * Per-recipient outcomes are the `Delivery` union below; one attempt folds
 * into the `SendOutcome` union, which is what decides idempotency storage:
 *
 * | outcome  | meaning                                        | 24 h record    |
 * | -------- | ---------------------------------------------- | -------------- |
 * | Accepted | every recipient was accepted by the provider   | yes — replay   |
 * | Partial  | at least one accepted, at least one not        | yes — replay   |
 * | Failed   | no acceptance observed; every refusal definite | no — retryable |
 * | Unknown  | no acceptance observed; ≥1 `outcome_unknown`   | no — retryable |
 *
 * A record replays the earlier attempt's response byte-identically and
 * submits nothing, so recording a `Partial` outcome is what guarantees a
 * retry with the same key never re-sends to the recipients the provider
 * already accepted. A `Failed` / `Unknown` / rejected-only attempt is
 * deliberately not recorded, so a retry with the same key really retries (and
 * the key stays free, so that retry may carry different content).
 *
 * `Unknown` means acceptance was never *observed*, not that the provider
 * refused: the data bytes left and no reply arrived, so the message may
 * already be queued and a retry can duplicate it. The per-recipient error
 * says so; inspect the relay log before retrying.
 *
 * The record keeps its `{ digest, status, body }` shape and always stores
 * `status: 200` — internal, so the `/email/send` JSON stays unchanged.
 *
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy"). Noite adaptations (KV idempotency
 * instead of SQL admission, SMTP transport instead of the `send_email`
 * binding) are marked inline.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import {
  asString,
  assertNever,
  encoder,
  isRecord,
  json,
  sanitizeForLog,
} from "../auth.ts";
import type { EmailConfig, ProxyConfig } from "../config.ts";
import type { Env, MailKvNamespace, ProxyDeps, SocketConnect } from "../env.ts";
import type { SmtpRecipientOutcome } from "./smtp.ts";
import { smtpSubmit } from "./smtp.ts";
import type { EmailProviderDeadline, RecipientResult } from "./validate.ts";
import {
  base64Decode,
  createEmailProviderDeadline,
  customMimeHeaderBytesWithinLimit,
  EMAIL_SEND_DEADLINE_MS,
  logSend,
  mimeFromRefusalDetail,
  strictFromRe,
} from "./validate.ts";

/** Ported from Void `platform/packages/proxy/src/email.ts`. */
export const MAX_MIME_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_RECIPIENT_LENGTH = 320;
const MAX_SENDER_LENGTH = 320;
const MAX_REQUEST_ID_LENGTH = 128;
const IDEMPOTENCY_KEY_PREFIX = "idemp/v1/";

// 24 h
const IDEMPOTENCY_TTL_SECONDS = 86_400;
const EMAIL_SEND_FINALIZATION_MARGIN_MS = 5000;
const SMTP_CONNECT_TIMEOUT_MS = 10_000;
const SMTP_COMMAND_TIMEOUT_MS = 10_000;

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

/**
 * Conservative RFC 5321 mailbox grammar (dot-atom only — no quoted-strings,
 * no domain literals, no display names): every recipient must parse as one
 * `local@domain` before admission. Anything outside it (CR/LF/NUL, `<`/`>`,
 * spaces, a second `@`, quoted local parts) is refused outright, so no
 * recipient can smuggle an SMTP line past the allowlist or the envelope.
 */
const LOCAL_ATOM_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/u;
const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

interface ParsedMailbox {
  address: string;
  local: string;
  domain: string;
}

/** Parse one addr-spec into its `(local, domain)` pair, or `null`. */
const parseMailbox = (address: string): ParsedMailbox | null => {
  const at = address.indexOf("@");

  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1) {
    return null;
  }

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  // RFC 5321 §4.5.3.1.3 size caps (the 320-char envelope cap ran first).
  if (local.length > 64 || domain.length > 255) {
    return null;
  }

  const atoms = local.split(".");

  if (
    atoms.some((atom) => atom.length === 0 || !LOCAL_ATOM_RE.test(atom)) ||
    domain
      .split(".")
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !DOMAIN_LABEL_RE.test(label)
      )
  ) {
    return null;
  }

  return { address, domain, local };
};

/**
 * Allowlist admission on the parsed `(local, domain)` pair: exact entries
 * match the whole address, `@domain` entries match the domain exactly.
 * Never a string suffix — `sub.example.com` is not `@example.com`, and a
 * recipient carrying trailing garbage cannot match by suffix.
 */
const isAllowlisted = (
  entries: AllowEntry[],
  recipient: ParsedMailbox
): boolean => {
  for (const entry of entries) {
    if (entry.type === "exact") {
      if (recipient.address === entry.value) {
        return true;
      }
    } else if (recipient.domain === entry.value.slice(1)) {
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
  // never appear in validated addr-specs (a strict grammar subset of
  // printable ASCII) or the base64 body.
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

/**
 * `/email/send` refusals as one closed type plus one status mapping.
 *
 * Every validation helper returns a `Refusal` (never a bare `Response`), so
 * the order in `validateEmailRequest` is the only precedence rule and the
 * status/code pair lives in exactly one table. `status: 200` entries are the
 * endpoint's historical compatibility behaviour (`INVALID_TO` with no
 * recipients, `INVALID_FROM` off-domain/not-pinned) — the wire contract the
 * runtime and its tests rely on, not a new choice.
 *
 * | kind                          | code            | status |
 * | ----------------------------- | --------------- | ------ |
 * | bodyInvalid                   | UPSTREAM_ERROR  | 400    |
 * | idempotencyKeyInvalid         | INVALID_TO      | 400    |
 * | idempotencyStoreUnconfigured  | UPSTREAM_ERROR  | 502    |
 * | mimeFromMismatch              | INVALID_FROM    | 403    |
 * | mimeHeadersTooLarge           | MIME_ERROR      | 413    |
 * | mimeInvalidBase64             | MIME_ERROR      | 400    |
 * | mimeTooLargeDecoded           | MIME_ERROR      | 413    |
 * | mimeTooLargeEncoded           | MIME_ERROR      | 413    |
 * | recipientInvalid              | INVALID_TO      | 400    |
 * | recipientTooLong              | INVALID_TO      | 413    |
 * | recipientsEmpty               | INVALID_TO      | 200    |
 * | recipientsTooMany             | INVALID_TO      | 413    |
 * | senderDomainUnconfigured      | UPSTREAM_ERROR  | 502    |
 * | senderIdentityUnconfigured    | UPSTREAM_ERROR  | 502    |
 * | senderNonAscii                | INVALID_FROM    | 403    |
 * | senderNotPinned               | INVALID_FROM    | 200    |
 * | senderTooLong                 | INVALID_FROM    | 413    |
 * | senderWrongDomain             | INVALID_FROM    | 200    |
 * | smtpMisconfigured             | UPSTREAM_ERROR  | 502    |
 * | smtpUnconfigured              | UPSTREAM_ERROR  | 502    |
 */
interface RefusalMapping {
  readonly code: string;
  readonly status: number;
}

const REFUSAL_MAPPING = {
  bodyInvalid: { code: "UPSTREAM_ERROR", status: 400 },
  idempotencyKeyInvalid: { code: "INVALID_TO", status: 400 },
  idempotencyStoreUnconfigured: { code: "UPSTREAM_ERROR", status: 502 },
  mimeFromMismatch: { code: "INVALID_FROM", status: 403 },
  mimeHeadersTooLarge: { code: "MIME_ERROR", status: 413 },
  mimeInvalidBase64: { code: "MIME_ERROR", status: 400 },
  mimeTooLargeDecoded: { code: "MIME_ERROR", status: 413 },
  mimeTooLargeEncoded: { code: "MIME_ERROR", status: 413 },
  recipientInvalid: { code: "INVALID_TO", status: 400 },
  recipientTooLong: { code: "INVALID_TO", status: 413 },
  recipientsEmpty: { code: "INVALID_TO", status: 200 },
  recipientsTooMany: { code: "INVALID_TO", status: 413 },
  senderDomainUnconfigured: { code: "UPSTREAM_ERROR", status: 502 },
  senderIdentityUnconfigured: { code: "UPSTREAM_ERROR", status: 502 },
  senderNonAscii: { code: "INVALID_FROM", status: 403 },
  senderNotPinned: { code: "INVALID_FROM", status: 200 },
  senderTooLong: { code: "INVALID_FROM", status: 413 },
  senderWrongDomain: { code: "INVALID_FROM", status: 200 },
  smtpMisconfigured: { code: "UPSTREAM_ERROR", status: 502 },
  smtpUnconfigured: { code: "UPSTREAM_ERROR", status: 502 },
} as const satisfies Record<string, RefusalMapping>;

type RefusalKind = keyof typeof REFUSAL_MAPPING;

interface Refusal {
  readonly _tag: "Refusal";
  readonly kind: RefusalKind;
  readonly message: string;
}

const refusalResponse = (refusal: Refusal): Response => {
  const mapping = REFUSAL_MAPPING[refusal.kind];

  return emailError(mapping.code, refusal.message, mapping.status);
};

/**
 * Per-recipient delivery, one closed union shared by submission, idempotency
 * storage and the wire mapping.
 *
 * `provider_accepted` is the only success state; `rejected` means the
 * allowlist refused the address; `failed` means the provider definitively did
 * not accept it; `outcome_unknown` means the message may have been queued
 * (never retry blindly).
 */
type Delivery =
  | { readonly _tag: "ProviderAccepted"; readonly messageId: string }
  | {
      readonly _tag: "Rejected";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly _tag: "Failed";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly code: string;
      readonly message: string;
    };

/** The only place a delivery becomes the Void-compatible wire shape. */
const toRecipientResult = (
  recipient: string,
  delivery: Delivery
): RecipientResult => {
  switch (delivery._tag) {
    case "ProviderAccepted": {
      return {
        messageId: delivery.messageId,
        ok: true,
        recipient,
        state: "provider_accepted",
      };
    }

    case "Rejected": {
      return {
        error: { code: delivery.code, message: delivery.message },
        ok: false,
        recipient,
        state: "rejected",
      };
    }

    case "Failed": {
      return {
        error: { code: delivery.code, message: delivery.message },
        ok: false,
        recipient,
        state: "failed",
      };
    }

    case "OutcomeUnknown": {
      return {
        error: { code: delivery.code, message: delivery.message },
        ok: false,
        recipient,
        state: "outcome_unknown",
      };
    }

    default: {
      return assertNever(delivery);
    }
  }
};

interface DeliveryEntry {
  readonly delivery: Delivery;
  readonly recipient: string;
}

type OutcomeTag = "Accepted" | "Failed" | "Partial" | "Unknown";

/**
 * One attempt, folded from its per-recipient deliveries. `deliveries` holds
 * one entry per requested recipient, in requested order (never empty: the
 * envelope refuses a send with no recipients).
 */
interface SendOutcome {
  readonly _tag: OutcomeTag;
  readonly deliveries: readonly DeliveryEntry[];
}

/**
 * Which outcomes are recorded for 24 h. Only an attempt that got at least one
 * recipient accepted is replayable: the record replays the earlier response
 * and submits nothing, so recording a `Partial` keeps a retry from re-sending
 * to the recipients the provider already accepted. A `Failed` / `Unknown` /
 * rejected-only attempt is not recorded, so a retry really retries.
 */
const OUTCOME_RECORDED = {
  Accepted: true,
  Failed: false,
  Partial: true,
  Unknown: false,
} as const satisfies Record<OutcomeTag, boolean>;

/** Fold one attempt's deliveries into its outcome (see the module table). */
const classifyOutcome = (deliveries: readonly DeliveryEntry[]): SendOutcome => {
  let accepted = 0;
  let unknown = 0;

  for (const { delivery } of deliveries) {
    switch (delivery._tag) {
      case "ProviderAccepted": {
        accepted += 1;
        break;
      }

      case "OutcomeUnknown": {
        unknown += 1;
        break;
      }

      case "Failed":
      case "Rejected": {
        break;
      }

      default: {
        return assertNever(delivery);
      }
    }
  }

  // `accepted > 0` first: zero deliveries cannot be reached through the
  // envelope (it refuses an empty recipient list), and if that invariant ever
  // broke, the safe answer is "nothing to record", not a replayable empty
  // success.
  if (accepted > 0) {
    return {
      _tag: accepted === deliveries.length ? "Accepted" : "Partial",
      deliveries,
    };
  }

  return { _tag: unknown > 0 ? "Unknown" : "Failed", deliveries };
};

const finishEmailSend = async (
  mailKv: MailKvNamespace,
  idempotencyKey: string,
  digest: string,
  projectId: string,
  requestId: string,
  outcome: SendOutcome
): Promise<Response> => {
  const operationId = crypto.randomUUID();
  const { deliveries } = outcome;

  const wire = deliveries.map((entry) =>
    toRecipientResult(entry.recipient, entry.delivery)
  );

  const accepted = deliveries.flatMap((entry) =>
    entry.delivery._tag === "ProviderAccepted"
      ? [
          {
            messageId: entry.delivery.messageId,
            recipient: entry.recipient,
            state: "provider_accepted",
          },
        ]
      : []
  );

  const body: unknown =
    outcome._tag === "Accepted"
      ? { ids: accepted, ok: true, operationId }
      : { deliveries: wire, ok: false, operationId };

  logSend(projectId, requestId, wire);

  // Only an accepted / partially accepted attempt is stored; its replay is
  // what keeps a retry from re-sending to the recipients already accepted.
  // Best-effort store: a KV failure here must not turn an accepted send into
  // an error (a repeat may double-send — the documented at-least-once limit).
  if (OUTCOME_RECORDED[outcome._tag]) {
    await mailKv
      .put(
        idempotencyKey,
        JSON.stringify({ body, digest, status: 200 } satisfies StoredOutcome),
        {
          expirationTtl: IDEMPOTENCY_TTL_SECONDS,
        }
      )
      .catch(() => null);
  }

  return json(body, 200);
};

interface ValidatedEmailRequest {
  readonly _tag: "Validated";
  fromLower: string;
  mimeBase64: string;
  raw: Uint8Array;
  recipients: ParsedMailbox[];
  requestId: string;
  operationKey: string;
  senderDomain: string;
  mailKv: MailKvNamespace;
}

/**
 * Normalize, dedupe and strictly validate recipients, or the refusal to
 * return. Every address must parse as one addr-spec here — before the
 * allowlist, the digest and the SMTP session — so a malformed recipient
 * fails the whole request instead of riding the per-recipient shape.
 */
const normalizeEmailRecipients = (
  recipientsRaw: unknown[]
): { recipients: ParsedMailbox[] } | Refusal => {
  const recipients: ParsedMailbox[] = [];
  const seen = new Set<string>();

  for (const r of recipientsRaw) {
    if (typeof r !== "string") {
      continue;
    }

    // Before `.trim().toLowerCase()` — that call is the allocation.
    if (r.length > MAX_RECIPIENT_LENGTH) {
      return {
        _tag: "Refusal",
        kind: "recipientTooLong",
        message: `recipient exceeds ${MAX_RECIPIENT_LENGTH} characters`,
      };
    }

    const lower = r.trim().toLowerCase();

    if (!lower || seen.has(lower)) {
      continue;
    }

    // The address is deliberately not echoed back: it just failed the
    // grammar, so it may carry control bytes or SMTP metacharacters.
    const mailbox = parseMailbox(lower);

    if (!mailbox) {
      return {
        _tag: "Refusal",
        kind: "recipientInvalid",
        message: "invalid recipient address",
      };
    }

    seen.add(lower);
    recipients.push(mailbox);
  }

  if (recipients.length === 0) {
    return {
      _tag: "Refusal",
      kind: "recipientsEmpty",
      message: "no recipients",
    };
  }

  return { recipients };
};

/** Decode and bound the MIME payload, or the refusal to return. */
const validateEmailMime = (
  mimeBase64: string
): { raw: Uint8Array } | Refusal => {
  // Pre-decode size guard — base64 expands ~4/3, so a base64 string longer
  // than `MAX_MIME_BYTES * 4 / 3 + 4` can't decode within the limit. Reject
  // before allocating for what we'd reject anyway.
  if (mimeBase64.length > Math.ceil((MAX_MIME_BYTES * 4) / 3) + 4) {
    return {
      _tag: "Refusal",
      kind: "mimeTooLargeEncoded",
      message: `mime exceeds ${MAX_MIME_BYTES} bytes (base64 length ${mimeBase64.length})`,
    };
  }

  let raw: Uint8Array;

  try {
    raw = base64Decode(mimeBase64);
  } catch {
    return {
      _tag: "Refusal",
      kind: "mimeInvalidBase64",
      message: "invalid base64 mime",
    };
  }

  if (raw.byteLength > MAX_MIME_BYTES) {
    return {
      _tag: "Refusal",
      kind: "mimeTooLargeDecoded",
      message: `mime exceeds ${MAX_MIME_BYTES} bytes (got ${raw.byteLength})`,
    };
  }

  if (!customMimeHeaderBytesWithinLimit(raw)) {
    return {
      _tag: "Refusal",
      kind: "mimeHeadersTooLarge",
      message: "custom headers exceed the 16 KiB limit",
    };
  }

  return { raw };
};

/** Pin the envelope sender to `<slug>[+tag]@<domain>`, or the refusal. */
const validateEmailSender = (
  env: Env,
  from: string,
  senderDomain: string
): { fromLower: string } | Refusal => {
  // Noite has no custom-domain `send_raw` path in v1: the sender must be on the
  // configured domain.
  const fromAt = from.indexOf("@");
  const fromDomain = fromAt === -1 ? "" : from.slice(fromAt + 1).toLowerCase();

  if (fromDomain !== "" && fromDomain !== senderDomain) {
    return {
      _tag: "Refusal",
      kind: "senderWrongDomain",
      message: `from address must use the configured domain ${senderDomain}`,
    };
  }

  // The envelope is forwarded verbatim, so validation has to run on bytes that
  // cannot change under case folding (U+212A lowercases to 'k'). Refuse
  // non-ASCII before that.
  if (!/^[\u0021-\u007E]+$/u.test(from)) {
    return {
      _tag: "Refusal",
      kind: "senderNonAscii",
      message: "from address must be printable ASCII",
    };
  }

  // Sender ownership: Void checks this against PostgreSQL in admission; Noite
  // pins the local part to the app slug the runner injected. Without the pin,
  // one tenant could send as another tenant's sender on the shared domain.
  const slugRaw = env.__VOID_PROJECT_SLUG;
  const slug = typeof slugRaw === "string" ? slugRaw.trim().toLowerCase() : "";

  if (!slug) {
    return {
      _tag: "Refusal",
      kind: "senderIdentityUnconfigured",
      message: "email sender identity is not configured",
    };
  }

  const fromLower = from.toLowerCase();

  if (!strictFromRe(senderDomain).test(fromLower)) {
    return {
      _tag: "Refusal",
      kind: "senderNotPinned",
      message: `from address must be <${slug}>[+tag]@${senderDomain}`,
    };
  }

  const fromLocal = fromLower.slice(0, fromLower.indexOf("@"));
  const localPrefix = fromLocal.split("+")[0] ?? "";

  if (localPrefix !== slug) {
    return {
      _tag: "Refusal",
      kind: "senderNotPinned",
      message: `from address must be <${slug}>[+tag]@${senderDomain}`,
    };
  }

  return { fromLower };
};

/** Derive the idempotency operation key, or the refusal to return. */
const resolveOperationKey = (
  body: Record<string, unknown>
): { operationKey: string; requestId: string } | Refusal => {
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
      _tag: "Refusal",
      kind: "idempotencyKeyInvalid",
      message: "invalid idempotency key",
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

/**
 * Validate the send request envelope, or the refusal to return.
 *
 * The order below is the precedence contract (keys → presence → caps → sender
 * config → recipients → MIME → sender pin → MIME `From` → idempotency store);
 * the first refusal wins.
 */
const validateEmailRequest = (
  env: Env,
  config: ProxyConfig,
  body: Record<string, unknown>
): ValidatedEmailRequest | Refusal => {
  const from = asString(body.from);
  const mimeBase64 = asString(body.mimeBase64);
  const keys = resolveOperationKey(body);

  if ("kind" in keys) {
    return keys;
  }

  const { operationKey, requestId } = keys;
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : null;

  if (!from || !mimeBase64 || !recipientsRaw) {
    return {
      _tag: "Refusal",
      kind: "bodyInvalid",
      message: "invalid body",
    };
  }

  // Bound the list before the normalization loop below allocates per entry.
  if (recipientsRaw.length > MAX_RECIPIENTS) {
    return {
      _tag: "Refusal",
      kind: "recipientsTooMany",
      message: `too many recipients (max ${MAX_RECIPIENTS}, got ${recipientsRaw.length})`,
    };
  }

  // Bound the sender before anything copies it.
  if (from.length > MAX_SENDER_LENGTH) {
    return {
      _tag: "Refusal",
      kind: "senderTooLong",
      message: `sender exceeds ${MAX_SENDER_LENGTH} characters`,
    };
  }

  // Fail closed on missing sender configuration before admission.
  if (config.senderDomain._tag !== "Ready") {
    return {
      _tag: "Refusal",
      kind: "senderDomainUnconfigured",
      message: "email sender domain is not configured",
    };
  }

  const { value: senderDomain } = config.senderDomain;
  const normalized = normalizeEmailRecipients(recipientsRaw);

  if ("_tag" in normalized) {
    return normalized;
  }

  const mime = validateEmailMime(mimeBase64);

  if ("_tag" in mime) {
    return mime;
  }

  const sender = validateEmailSender(env, from, senderDomain);

  if ("_tag" in sender) {
    return sender;
  }

  // The envelope is pinned; now pin what the recipient will actually SEE.
  const mimeFromDetail = mimeFromRefusalDetail(mime.raw, from);

  if (mimeFromDetail !== null) {
    return {
      _tag: "Refusal",
      kind: "mimeFromMismatch",
      message: mimeFromDetail,
    };
  }

  if (config.mailKv._tag !== "Ready") {
    return {
      _tag: "Refusal",
      kind: "idempotencyStoreUnconfigured",
      message: "email idempotency store is not configured",
    };
  }

  return {
    _tag: "Validated",
    fromLower: sender.fromLower,
    mailKv: config.mailKv.value,
    mimeBase64,
    operationKey,
    raw: mime.raw,
    recipients: normalized.recipients,
    requestId,
    senderDomain,
  };
};

/**
 * Idempotency lookup states: no usable record (send), a replayable record, or
 * the store being unavailable (503). A parseable record with the wrong shape
 * counts as `Missing` — re-sending is today's behavior.
 */
type StoredLookup =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Stored"; readonly outcome: StoredOutcome }
  | { readonly _tag: "Unavailable" };

/** Read a recorded idempotency outcome, or the failure state to return. */
const readStoredOutcome = async (
  mailKv: MailKvNamespace,
  idempotencyKey: string
): Promise<StoredLookup> => {
  try {
    const rawStored = await mailKv.get(idempotencyKey);

    if (rawStored === null) {
      return { _tag: "Missing" };
    }

    const parsed: unknown = JSON.parse(rawStored);

    if (
      isRecord(parsed) &&
      typeof parsed.digest === "string" &&
      typeof parsed.status === "number" &&
      "body" in parsed
    ) {
      return {
        _tag: "Stored",
        outcome: {
          body: parsed.body,
          digest: parsed.digest,
          status: parsed.status,
        },
      };
    }

    return { _tag: "Missing" };
  } catch {
    return { _tag: "Unavailable" };
  }
};

/**
 * Submission states for one `/email/send`:
 * `Skipped` (nothing was admitted), `Smtp` (a completed transaction with a
 * per-recipient outcome map), or `Expired` (the batch deadline elapsed, so
 * every admitted recipient is unresolved).
 */
type Submission =
  | { readonly _tag: "Skipped" }
  | {
      readonly _tag: "Smtp";
      readonly outcomes: ReadonlyMap<string, SmtpRecipientOutcome>;
    }
  | { readonly _tag: "Expired" };

/** Submit admitted recipients within the batch deadline. */
const submitAdmittedEmail = async (
  emailConfig: EmailConfig,
  validated: ValidatedEmailRequest,
  admitted: ReadonlySet<string>,
  sendDeadline: EmailProviderDeadline,
  deps: ProxyDeps
): Promise<Submission | Refusal> => {
  if (admitted.size === 0) {
    return { _tag: "Skipped" };
  }

  if (emailConfig._tag === "Off") {
    return {
      _tag: "Refusal",
      kind: "smtpUnconfigured",
      message: "email sending is not configured",
    };
  }

  if (emailConfig._tag === "Misconfigured") {
    return {
      _tag: "Refusal",
      kind: "smtpMisconfigured",
      message: emailConfig.detail,
    };
  }

  const smtpConfig = emailConfig.value;

  try {
    const outcomes = await sendDeadline.run(
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

    return { _tag: "Smtp", outcomes };
  } catch {
    // Overall batch deadline elapsed: submissions may be in flight, so every
    // admitted recipient is unresolved.
    return { _tag: "Expired" };
  }
};

/** One requested recipient's delivery state, from the submission result. */
const deliveryFor = (
  recipient: string,
  admitted: ReadonlySet<string>,
  submission: Submission
): Delivery => {
  if (!admitted.has(recipient)) {
    return {
      _tag: "Rejected",
      code: "UNVERIFIED_DESTINATION",
      message: `recipient '${recipient}' is not allowlisted`,
    };
  }

  if (submission._tag === "Expired") {
    return {
      _tag: "OutcomeUnknown",
      code: "OUTCOME_UNKNOWN",
      message: "provider outcome unknown; inspect email logs before retrying",
    };
  }

  const outcome =
    submission._tag === "Smtp" ? submission.outcomes.get(recipient) : null;

  if (!outcome) {
    return {
      _tag: "OutcomeUnknown",
      code: "OUTCOME_UNKNOWN",
      message: "provider outcome unknown; inspect email logs before retrying",
    };
  }

  if (outcome.ok) {
    return { _tag: "ProviderAccepted", messageId: outcome.messageId };
  }

  return outcome.state === "failed"
    ? { _tag: "Failed", code: outcome.code, message: outcome.message }
    : {
        _tag: "OutcomeUnknown",
        code: outcome.code,
        message: outcome.message,
      };
};

export const handleEmailSend = async (
  env: Env,
  config: ProxyConfig,
  body: Record<string, unknown>,
  projectId: string,
  deps: ProxyDeps
): Promise<Response> => {
  const sendDeadline = createEmailProviderDeadline(
    deps.timeouts?.emailTotalMs ?? EMAIL_SEND_DEADLINE_MS
  );

  const validated = validateEmailRequest(env, config, body);

  if (validated._tag === "Refusal") {
    return refusalResponse(validated);
  }

  const digest = await emailPayloadDigest(
    validated.fromLower,
    validated.recipients.map((r) => r.address),
    validated.mimeBase64
  );

  const idempotencyKey = `${IDEMPOTENCY_KEY_PREFIX}${validated.operationKey}`;
  const stored = await readStoredOutcome(validated.mailKv, idempotencyKey);

  switch (stored._tag) {
    case "Unavailable": {
      return emailError("UPSTREAM_ERROR", "email admission unavailable", 503);
    }

    case "Stored": {
      if (stored.outcome.digest !== digest) {
        return emailError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key has different content",
          409
        );
      }

      return json(stored.outcome.body, stored.outcome.status);
    }

    case "Missing": {
      break;
    }

    default: {
      return assertNever(stored);
    }
  }

  // Admission (replaces Void's SQL admission): operator allowlist of exact
  // addresses and/or `@domain` exact-domain entries. Empty allowlist = fail
  // closed. Non-admitted recipients ride the partial-deliveries shape so one
  // unlisted address does not fail admitted ones (malformed addresses never
  // reach here — normalization refused the whole request).
  const allowlist = parseAllowlist(env.VOID_PROXY_EMAIL_ALLOWLIST);

  const admitted = new Set(
    validated.recipients
      .filter((r) => isAllowlisted(allowlist, r))
      .map((r) => r.address)
  );

  const submission = await submitAdmittedEmail(
    config.email,
    validated,
    admitted,
    sendDeadline,
    deps
  );

  if (submission._tag === "Refusal") {
    return refusalResponse(submission);
  }

  // One entry per requested recipient, in requested order (the runtime matches
  // them as a set, but ordered output is easier to read and test).
  const deliveries: DeliveryEntry[] = validated.recipients.map(
    ({ address: recipient }) => ({
      delivery: deliveryFor(recipient, admitted, submission),
      recipient,
    })
  );

  return finishEmailSend(
    validated.mailKv,
    idempotencyKey,
    digest,
    projectId,
    validated.requestId,
    classifyOutcome(deliveries)
  );
};
