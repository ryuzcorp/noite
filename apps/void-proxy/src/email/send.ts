/**
 * `POST /email/send` (Void's response contract verbatim): allowlist admission,
 * KV idempotency, and SMTP submission.
 *
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy"). Noite adaptations (KV idempotency
 * instead of SQL admission, SMTP transport instead of the `send_email`
 * binding) are marked inline.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { asString, encoder, isRecord, json, sanitizeForLog } from "../auth.ts";
import type { Env, MailKvNamespace, ProxyDeps, SocketConnect } from "../env.ts";
import type { SmtpMode, SmtpRecipientOutcome } from "./smtp.ts";
import { smtpSubmit } from "./smtp.ts";
import type { EmailProviderDeadline, RecipientResult } from "./validate.ts";
import {
  base64Decode,
  createEmailProviderDeadline,
  customMimeHeaderBytesWithinLimit,
  EMAIL_SEND_DEADLINE_MS,
  logSend,
  readSenderDomain,
  refuseMimeFromMismatch,
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
): { recipients: ParsedMailbox[] } | { response: Response } => {
  const recipients: ParsedMailbox[] = [];
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

    // The address is deliberately not echoed back: it just failed the
    // grammar, so it may carry control bytes or SMTP metacharacters.
    const mailbox = parseMailbox(lower);

    if (!mailbox) {
      return {
        response: emailError("INVALID_TO", "invalid recipient address", 400),
      };
    }

    seen.add(lower);
    recipients.push(mailbox);
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

export const handleEmailSend = async (
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
    validated.recipients.map((r) => r.address),
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

  for (const { address: recipient } of validated.recipients) {
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
