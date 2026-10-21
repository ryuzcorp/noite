/**
 * Sentry envelope parsing for the browser-error ingest (ROADMAP, Error
 * tracking phase 2): split a Sentry envelope body into stored `event` items
 * mapped onto the runner's `errors.ingest` shape, plus dropped item types.
 * Every field is schema-guarded at this boundary: unknown wire JSON narrows
 * to `Wire`/`WireValue` before anything is read.
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

/** A JSON value read from the wire: primitives, arrays, or string-keyed objects. */
type WireValue = string | number | boolean | null | WireValue[] | Wire;

/** A JSON object read from the wire: every value narrows via a guard below. */
interface Wire {
  [key: string]: WireValue;
}

/** A wire value holding a JSON object (arrays excluded: they are lists). */
const isWire = (value: WireValue): value is Wire =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A wire value holding text. */
const isTextValue = (value: WireValue): value is string =>
  typeof value === "string";

/** A wire value holding a number. */
const isNumberValue = (value: WireValue): value is number =>
  typeof value === "number";

/** Read a string field: anything unexpected decodes to empty. */
const wireString = (node: Wire, key: string): string => {
  const value: WireValue = node[key];

  return isTextValue(value) ? value : "";
};

/** Read a finite-number field: anything unexpected decodes to null. */
const wireNumber = (node: Wire, key: string): number | null => {
  const value: WireValue = node[key];

  return isNumberValue(value) && Number.isFinite(value) ? value : null;
};

/** Read a list field: anything unexpected decodes to empty. */
const wireList = (node: Wire, key: string): WireValue[] => {
  const value: WireValue = node[key];

  return Array.isArray(value) ? value : [];
};

/** Read a child object field: anything unexpected decodes to null. */
const parseWireChild = (node: Wire, key: string): Wire | null => {
  const child: WireValue = node[key];

  return isWire(child) ? child : null;
};

/** A string field with envelope-trace fallback (release, environment). */
const firstString = (
  primary: Wire,
  fallback: Wire | null,
  key: string
): string => {
  const direct = wireString(primary, key);

  if (direct !== "") {
    return direct;
  }

  return fallback === null ? "" : wireString(fallback, key);
};

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

/** Prefix shared by every Sentry JavaScript SDK build name. */
const BROWSER_SDK_PREFIX = "sentry.javascript.";

/** Frontend SDK families: their `javascript`-platform events broke in a browser tab. */
const BROWSER_SDK_SUFFIXES = {
  angular: true,
  astro: true,
  browser: true,
  ember: true,
  gatsby: true,
  react: true,
  solid: true,
  svelte: true,
  vue: true,
} satisfies Record<string, true>;

/** Whether an SDK name is a browser build (exact family, no substring match). */
const isBrowserSdkName = (sdkName: string): boolean => {
  if (!sdkName.startsWith(BROWSER_SDK_PREFIX)) {
    return false;
  }

  return sdkName.slice(BROWSER_SDK_PREFIX.length) in BROWSER_SDK_SUFFIXES;
};

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

/** One wire frame onto the runner shape: non-objects decode to empty. */
const parseFrame = (frame: WireValue): SentryFrame => {
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
  const exception = parseWireChild(payload, "exception");

  if (exception === null) {
    return null;
  }

  const values = wireList(exception, "values").filter(isWire);
  const last: Wire | undefined = values.at(-1);

  return last ?? null;
};

/** The exception slice of an event: kind, message, and stack frames. */
interface ExceptionPart {
  frames: SentryFrame[];
  kind: string;
  message: string;
}

/** Narrow an event payload onto its exception slice. */
const parseExceptionPart = (payload: Wire): ExceptionPart => {
  const exception = primaryException(payload);

  if (exception === null) {
    return {
      frames: [],
      kind: "Message",
      message: clip(wireString(payload, "message")),
    };
  }

  const stacktrace = parseWireChild(exception, "stacktrace");

  return {
    frames:
      stacktrace === null
        ? []
        : wireList(stacktrace, "frames").map((frame) => parseFrame(frame)),
    kind: clip(wireString(exception, "type") || "Message"),
    message: clip(
      wireString(exception, "value") || wireString(payload, "message")
    ),
  };
};

/** The request slice of an event: page URL and user agent. */
interface RequestPart {
  url: string;
  userAgent: string;
}

/** Narrow an event payload onto its request slice. */
const parseRequestPart = (payload: Wire): RequestPart => {
  const request = parseWireChild(payload, "request");
  const headers = request === null ? null : parseWireChild(request, "headers");
  const rawUrl = request === null ? "" : wireString(request, "url");

  // The page URL with its query and fragment stripped: they can carry tokens
  // and would split one page's errors across issues.
  const url = rawUrl.split("?", 1)[0]?.split("#", 1)[0] ?? "";

  return {
    url: clip(url),
    userAgent: clip(headers === null ? "" : wireString(headers, "User-Agent")),
  };
};

/** The SDK slice of an event: SDK name and browser-vs-sdk source. */
interface SdkPart {
  sdkName: string;
  source: "browser" | "sdk";
}

/** Narrow an event payload onto its SDK slice. */
const parseSdkPart = (payload: Wire): SdkPart => {
  const sdk = parseWireChild(payload, "sdk");
  const sdkName = sdk === null ? "" : wireString(sdk, "name");

  // `browser` for browser SDK events (platform `javascript` + browser SDK
  // name), `sdk` for everything else (server SDKs, mobile, workers).
  if (
    wireString(payload, "platform") === "javascript" &&
    isBrowserSdkName(sdkName)
  ) {
    return { sdkName, source: "browser" };
  }

  return { sdkName, source: "sdk" };
};

/** The envelope slice of an event: fallbacks shared with the header trace. */
interface IdentityPart {
  environment: string;
  release: string;
  timestampUs: number;
  traceId: string;
}

/** Narrow an event payload plus envelope header onto the shared slice. */
const parseIdentityPart = (
  payload: Wire,
  envelopeHeader: Wire
): IdentityPart => {
  const trace = parseWireChild(envelopeHeader, "trace");
  const timestamp = wireNumber(payload, "timestamp");

  return {
    environment: clip(firstString(payload, trace, "environment")),
    release: clip(firstString(payload, trace, "release")),
    timestampUs: timestamp === null ? 0 : Math.round(timestamp * 1_000_000),
    traceId:
      wireString(envelopeHeader, "event_id") || wireString(payload, "event_id"),
  };
};

/** One `event` payload onto the runner shape (query stripped at this boundary). */
export const mapSentryEvent = (
  payload: Wire,
  envelopeHeader: Wire
): SentryEventItem => {
  const exception = parseExceptionPart(payload);
  const request = parseRequestPart(payload);
  const sdk = parseSdkPart(payload);
  const identity = parseIdentityPart(payload, envelopeHeader);

  return {
    environment: identity.environment,
    frames: exception.frames,
    kind: exception.kind,
    message: exception.message,
    release: identity.release,
    sdkName: sdk.sdkName,
    source: sdk.source,
    timestampUs: identity.timestampUs,
    traceId: identity.traceId,
    url: request.url,
    userAgent: request.userAgent,
  };
};

/** Parse one envelope line: blank lines and non-objects decode to null. */
const parseJsonLine = (line: string): Wire | null => {
  const trimmed = line.trim();

  if (trimmed === "") {
    return null;
  }

  try {
    const parsed: WireValue = JSON.parse(trimmed);

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
