/**
 * `/email/send` validation chain — ported from Void
 * `platform/packages/proxy/src/email.ts`: MIME `From:` pinning, sender and
 * header caps, and the provider deadline.
 *
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy").
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { sanitizeForLog } from "../auth.ts";
import type { Env } from "../env.ts";

const MAX_CUSTOM_HEADER_BYTES = 16 * 1024;
export const EMAIL_SEND_DEADLINE_MS = 50_000;
const EMAIL_PROVIDER_DEADLINE_MS = 30_000;

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
export const customMimeHeaderBytesWithinLimit = (raw: Uint8Array): boolean => {
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
export const readSenderDomain = (env: Env): string | null => {
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
export const strictFromRe = (domain: string): RegExp => {
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

/**
 * The refusal detail when a message's MIME `From:` is not the envelope
 * sender, or `null` when it is. The caller maps it into its one refusal table.
 */
export const mimeFromRefusalDetail = (
  raw: Uint8Array,
  from: string
): string | null => {
  const mimeFrom = readMimeFromAddrSpec(raw);

  if (mimeFrom.ok && mimeFrom.addrSpec.toLowerCase() === from.toLowerCase()) {
    return null;
  }

  const detail = mimeFrom.ok
    ? "the From header address does not match the envelope sender"
    : MIME_FROM_REFUSALS[mimeFrom.reason];

  return `mime From must be the envelope sender ${from}: ${detail}`;
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

export const base64Decode = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  let offset = 0;

  for (const ch of binary) {
    out[offset] = ch.codePointAt(0) ?? 0;
    offset += 1;
  }

  return out;
};

export interface RecipientResult {
  recipient: string;
  ok: boolean;
  state?: string;
  messageId?: string;
  error?: { code: string; message: string };
}

export const logSend = (
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
