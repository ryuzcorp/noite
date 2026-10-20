/**
 * Sentry envelope parsing for the browser-error ingest (ROADMAP, Error
 * tracking phase 2). Pure: the envelope route reads the (possibly gzipped)
 * body and hands its text here; this module splits the newline-delimited
 * envelope, keeps `event` items and names everything else dropped (sessions,
 * transactions/spans, replays, profiles, attachments, client reports, ...),
 * so the route answers those with a 200 and the SDK never retries them.
 *
 * Envelope shape (verified against `@sentry/browser` 11.8.0 wire bytes in
 * `sentry-fixtures/`): a JSON header line, then per item a JSON header line
 * plus one JSON payload line. An item header may carry `length` (attachments
 * and span batches); those lines are skipped by byte count, never parsed.
 * A line that is not JSON is skipped, never fatal — only a broken envelope
 * header rejects the whole body.
 */

const MAX_TEXT = 2000;

/** Clip a stored string: event payloads can embed whole request bodies. */
const clip = (value: string): string =>
  value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;

/** One Sentry stack frame, oldest-first exactly as the SDK sends it. */
export interface SentryFrame {
  function: string;
  inApp: boolean;
  location: string;
}

/** One `event` item mapped onto the runner's `errors.ingest` shape. */
export interface SentryEventItem {
  environment: string;
  frames: SentryFrame[];
  kind: string;
  message: string;
  release: string;
  sdkName: string;
  source: "browser" | "sdk";
  timestampUs: number;
  traceId: string;
  url: string;
  userAgent: string;
}

/** What one envelope body yields: stored events plus dropped item types. */
export interface ParsedEnvelope {
  dropped: string[];
  events: SentryEventItem[];
}

/** A JSON value read from the wire: unknown until a guard narrows it. */
type Wire = Record<string, unknown>;

/* oxlint-disable anti-slop/no-runtime-typeof -- the envelope boundary: every field is checked here before it is read, and nothing unguarded escapes. */
const isWire = (value: unknown): value is Wire =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wireString = (node: Wire, key: string): string => {
  const value = node[key];

  return typeof value === "string" ? value : "";
};

const wireNumber = (node: Wire, key: string): number | null => {
  const value = node[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const wireArray = (node: Wire, key: string): unknown[] => {
  const value = node[key];

  return Array.isArray(value) ? value : [];
};
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The `sentry_key` of an `X-Sentry-Auth` header (`Sentry sentry_key=.., ..`). */
export const parseSentryAuth = (header: string | null): string | null => {
  if (!header) {
    return null;
  }

  const prefix = "Sentry ";

  if (!header.startsWith(prefix)) {
    return null;
  }

  for (const part of header.slice(prefix.length).split(",")) {
    const [key, ...rest] = part.trim().split("=");

    if (key?.trim() === "sentry_key") {
      const value = rest.join("=").trim();

      if (value) {
        return value;
      }
    }
  }

  return null;
};

/** Frontend SDK families: their `javascript`-platform events broke in a browser tab. */
const BROWSER_SDK =
  /sentry\.javascript\.(angular|astro|browser|ember|gatsby|react|solid|svelte|vue)/u;

/** `filename:line:col` from a Sentry frame (any part may be missing). */
const frameLocation = (frame: Wire): string => {
  const filename = wireString(frame, "filename") || wireString(frame, "module");
  const lineno = wireNumber(frame, "lineno");
  const colno = wireNumber(frame, "colno");

  if (lineno === null) {
    return filename;
  }

  return colno === null
    ? `${filename}:${lineno}`
    : `${filename}:${lineno}:${colno}`;
};

const mapFrame = (frame: unknown): SentryFrame => {
  if (!isWire(frame)) {
    return { function: "", inApp: false, location: "" };
  }

  return {
    function: clip(wireString(frame, "function")),
    inApp: frame["in_app"] === true,
    location: clip(frameLocation(frame)),
  };
};

/** The primary exception: Sentry chains causes in `values`, last is newest. */
const primaryException = (payload: Wire): Wire | null => {
  const { exception } = payload;

  if (!isWire(exception)) {
    return null;
  }

  const values = wireArray(exception, "values").filter(isWire);

  return values.length > 0 ? (values.at(-1) as Wire) : null;
};

/** One `event` payload onto the runner shape (query stripped at this boundary). */
export const mapSentryEvent = (
  payload: Wire,
  envelopeHeader: Wire
): SentryEventItem => {
  const exception = primaryException(payload);
  const stacktrace =
    exception !== null && isWire(exception["stacktrace"])
      ? (exception["stacktrace"] as Wire)
      : null;
  const request = isWire(payload["request"])
    ? (payload["request"] as Wire)
    : null;
  const headers =
    request !== null && isWire(request["headers"])
      ? (request["headers"] as Wire)
      : null;
  const sdk = isWire(payload["sdk"]) ? (payload["sdk"] as Wire) : null;
  const trace = isWire(envelopeHeader["trace"])
    ? (envelopeHeader["trace"] as Wire)
    : null;
  const sdkName = sdk === null ? "" : wireString(sdk, "name");
  const timestamp = wireNumber(payload, "timestamp");

  // `browser` for browser SDK events (platform `javascript` + browser SDK
  // name), `sdk` for everything else (server SDKs, mobile, workers).
  const source =
    wireString(payload, "platform") === "javascript" &&
    BROWSER_SDK.test(sdkName)
      ? "browser"
      : "sdk";

  // The page URL with its query and fragment stripped: they can carry tokens
  // and would split one page's errors across issues.
  const rawUrl = request === null ? "" : wireString(request, "url");
  const url = rawUrl.split("?", 1)[0]?.split("#", 1)[0] ?? "";

  return {
    environment: clip(
      wireString(payload, "environment") ||
        wireString(trace ?? {}, "environment")
    ),
    frames:
      stacktrace === null ? [] : wireArray(stacktrace, "frames").map(mapFrame),
    kind: clip(
      (exception === null ? "" : wireString(exception, "type")) || "Message"
    ),
    message: clip(
      (exception === null ? "" : wireString(exception, "value")) ||
        wireString(payload, "message")
    ),
    release: clip(
      wireString(payload, "release") || wireString(trace ?? {}, "release")
    ),
    sdkName,
    source,
    timestampUs: timestamp === null ? 0 : Math.round(timestamp * 1_000_000),
    traceId:
      wireString(envelopeHeader, "event_id") || wireString(payload, "event_id"),
    url: clip(url),
    userAgent: clip(headers === null ? "" : wireString(headers, "User-Agent")),
  };
};

const parseJsonLine = (line: string): Wire | null => {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);

    return isWire(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Split one envelope body into stored events and dropped item types. */
export const parseSentryEnvelope = (text: string): ParsedEnvelope => {
  const lines = text.split("\n");
  const header = parseJsonLine(lines[0] ?? "");

  if (header === null) {
    throw new Error("invalid sentry envelope");
  }

  const dropped: string[] = [];
  const events: SentryEventItem[] = [];
  let i = 1;

  while (i < lines.length) {
    const itemHeader = parseJsonLine(lines[i] ?? "");
    i += 1;

    if (itemHeader === null) {
      continue;
    }

    const length = wireNumber(itemHeader, "length");

    if (length !== null) {
      // A sized payload (attachments, span batches): skip `length` bytes
      // without parsing, so binary bodies cannot desync the scan.
      let skipped = 0;

      while (i < lines.length && skipped < length) {
        // Item `length` counts bytes, not lines: re-encode each line (plus
        // its newline) so a binary payload cannot desync the scan.
        skipped += new TextEncoder().encode(lines[i] ?? "").length + 1;
        i += 1;
      }

      const itemType = wireString(itemHeader, "type");
      dropped.push(itemType || "unknown");
      continue;
    }

    if (i >= lines.length) {
      break;
    }

    const payload = parseJsonLine(lines[i] ?? "");
    i += 1;

    if (payload === null) {
      continue;
    }

    const itemType = wireString(itemHeader, "type");

    if (itemType === "event") {
      events.push(mapSentryEvent(payload, header));
    } else {
      dropped.push(itemType || "unknown");
    }
  }

  return { dropped, events };
};
