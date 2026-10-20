import { DEFAULT_RPM, rateLimitDecision } from "../../lib/rate-limit";
import {
  RunnerRpcError,
  runnerIngestErrors,
  stampRunnerEnv,
} from "../../lib/runner";
import type {
  ParsedEnvelope,
  SentryEventItem,
} from "../../lib/sentry-envelope";
import {
  parseSentryAuth,
  parseSentryEnvelope,
} from "../../lib/sentry-envelope";
import { readBoundedText, tooLarge } from "../body";
import { runnerConfig } from "../config";
import type { RouteHandler } from "../config";

/** Largest envelope the browser-error ingest reads, raw or inflated: one
 * exception event is a few KiB, so this bounds what a single tab (or a gzip
 * bomb) can make the worker buffer. */
export const ENVELOPE_MAX_BYTES = 200 * 1024;

const ALLOW_HEADERS = "content-type, x-sentry-auth";

const ALLOW_METHODS = "POST, OPTIONS";

const PROJECT_PATTERN = /^\d+$/u;

/** One refusal for a wrong key or an unknown project number: the runner
 * reports both as a 404-code JSON-RPC error, and answering them alike
 * reveals neither. */
const REFUSAL = "invalid key or project";

/** Stamp the open-CORS header Sentry browser tabs need on every answer. */
const cors = (response: Response): Response => {
  response.headers.set("access-control-allow-origin", "*");

  return response;
};

const answer = (
  body: string,
  status: number,
  headers?: HeadersInit
): Response => cors(new Response(body, { headers, status }));

/** The envelope key: the `sentry_key` query param wins, else the sentry_key
 * of the `X-Sentry-Auth` header. Empty when the SDK sent neither. */
const requestKey = (request: Request): string => {
  const queryKey =
    new URL(request.url).searchParams.get("sentry_key")?.trim() ?? "";

  if (queryKey !== "") {
    return queryKey;
  }

  return parseSentryAuth(request.headers.get("x-sentry-auth")) ?? "";
};

/** Read a gzip body while counting the inflated bytes, so a bomb that is
 * tiny on the wire still trips the cap without ever fully inflating. Null
 * when the inflated body runs past `max`. */
const readGunzipBounded = async (
  request: Request,
  max: number
): Promise<string | null> => {
  if (!request.body) {
    return "";
  }

  const reader = request.body
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();

  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be counted in arrival order
    const { done, value } = await reader.read();

    if (done) {
      return text + decoder.decode();
    }

    received += value.byteLength;

    if (received > max) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- stop the inflate as soon as it is over the bound
      await reader.cancel();

      return null;
    }

    text += decoder.decode(value, { stream: true });
  }
};

/** Read the envelope text, still capped after gzip inflation. Throws on a
 * corrupt gzip stream; null when the (possibly inflated) body runs long. */
const readEnvelopeBody = (request: Request): Promise<string | null> => {
  const encoding = request.headers.get("content-encoding") ?? "";

  if (encoding.toLowerCase().includes("gzip")) {
    return readGunzipBounded(request, ENVELOPE_MAX_BYTES);
  }

  return readBoundedText(request, ENVELOPE_MAX_BYTES);
};

/** Store one envelope's events under the project number. A 404-code runner
 * error (wrong key or unknown number) becomes the one refusal that reveals
 * neither; a missing token is a 500. */
const storeEvents = async (
  projectId: number,
  key: string,
  events: SentryEventItem[],
  env: KitEnv
): Promise<Response> => {
  if (!runnerConfig(env)) {
    return answer("RUNNER_TOKEN is not configured", 500);
  }

  stampRunnerEnv(env);

  try {
    const stored = await runnerIngestErrors(projectId, key, events);

    return answer(JSON.stringify(stored), 200, {
      "content-type": "application/json",
    });
  } catch (error) {
    if (error instanceof RunnerRpcError && error.code === 404) {
      return answer(REFUSAL, 403);
    }

    throw error;
  }
};

/** Parse one envelope body: invalid bytes are a 400, while an envelope with
 * no events (sessions, transactions, client reports) is a 200 that never
 * reaches the runner. */
const ingestText = (
  text: string,
  projectId: number,
  key: string,
  env: KitEnv
): Promise<Response> | Response => {
  let parsed: ParsedEnvelope;

  try {
    parsed = parseSentryEnvelope(text);
  } catch {
    return answer("invalid sentry envelope", 400);
  }

  if (parsed.events.length === 0) {
    return answer(JSON.stringify({ fingerprints: [] }), 200, {
      "content-type": "application/json",
    });
  }

  return storeEvents(projectId, key, parsed.events, env);
};

/** Sentry-compatible envelope ingest for browser tabs (`POST`
 * `/:projectId/envelope`, project number + `sentry_key` minted in
 * app-settings). Browser SDKs POST cross-origin, so CORS is open; the
 * per-key rate limit and the runner's key check are the gate. */
export const makeEnvelopeHandler = (deps?: {
  now?: () => number;
}): RouteHandler => {
  const now = deps?.now ?? Date.now;

  return async (request, env, params) => {
    const projectId = params?.projectId?.trim() ?? "";

    if (!PROJECT_PATTERN.test(projectId)) {
      return;
    }

    if (request.method === "OPTIONS") {
      return cors(
        new Response(null, {
          headers: {
            "access-control-allow-headers": ALLOW_HEADERS,
            "access-control-allow-methods": ALLOW_METHODS,
          },
          status: 204,
        })
      );
    }

    if (request.method !== "POST") {
      return answer("method not allowed", 405);
    }

    const key = requestKey(request);

    if (key === "") {
      return answer("sentry_key required", 401);
    }

    const decision = rateLimitDecision(`envelope:${key}`, DEFAULT_RPM, now());

    if (!decision.allowed) {
      return answer("rate limited", 429, {
        "retry-after": String(decision.retryAfter),
        "x-ratelimit-remaining": "0",
      });
    }

    let text: string | null;

    try {
      text = await readEnvelopeBody(request);
    } catch {
      return answer("invalid sentry envelope", 400);
    }

    if (text === null) {
      return cors(tooLarge());
    }

    return ingestText(text, Number(projectId), key, env);
  };
};

/** The default handler: wall-clock time, as the route file uses. */
export const handleEnvelope: RouteHandler = makeEnvelopeHandler();
