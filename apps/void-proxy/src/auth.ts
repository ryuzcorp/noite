/**
 * Shared request plumbing: bounded JSON body parsing, service-binding auth,
 * and the JSON/error/log response helpers every handler uses.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
const LARGE_JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const encoder = new TextEncoder();

const fatalDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

/** File and binary payload routes need more room than control operations. */
export const requestBodyMaxBytes = (path: string): number => {
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

export class RequestBodyError extends Error {
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
export const readRequestJson = async (
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

export const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

/** Constant-time string equality for the per-fleet proxy token. */
export const timingSafeEqual = (a: string, b: string): boolean => {
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

/**
 * Compile-time exhaustiveness for switches over closed tagged unions: a new
 * variant makes the `default` arm fail to compile instead of falling through.
 */
export const assertNever = (value: never): never => {
  throw new Error(`unreachable union member: ${JSON.stringify(value)}`);
};

export const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status });

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

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
