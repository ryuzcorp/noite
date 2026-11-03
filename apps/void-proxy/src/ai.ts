/**
 * `POST /ai/*`: the provider envelope codec and path-traversal guard, ported
 * from Void, over a static native provider map (Noite has no AI gateway, so
 * calls go provider-native — marked inline where it replaces the gateway).
 *
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy").
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { asRecord, asString, isRecord, json } from "./auth.ts";
import type { Env, ProxyDeps } from "./env.ts";

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

export const handleAiProvider = async (
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

export const readAiModelMap = (
  env: Env
): Record<string, AiModelMapping> | null => {
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

export const handleAiRun = async (
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

    // Upstream errors ride the JSON error path even when the caller asked to
    // stream — piping a 401/429/500 body as 200 SSE would mask auth/quota
    // failures from the caller.
    if (!response.ok || !stream || !response.body) {
      // Endpoint-native shape (documented, not translated to Workers AI shapes).
      return new Response(response.body, {
        headers: filteredResponseHeaders(response),
        status: response.status,
      });
    }

    return new Response(response.body, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("AI run error:", message);

    return json({ error: "upstream error" }, 502);
  }
};
