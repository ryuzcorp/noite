/** `POST /revalidate`: KV purge across all deployment ids, plus the matching `caches.default` edge entries. */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { errorMessage, json, sanitizeForLog } from "./auth.ts";
import type { Subsystem } from "./config.ts";
import type { EdgeCache, IsrKvNamespace, ProxyDeps } from "./env.ts";
import {
  denormalizeIsrPath,
  ISR_HOST_REGISTRY_PREFIX,
  ISR_V3_PREFIX,
  isrEdgeCacheUrlForToken,
  normalizeIsrPath,
  splitIsrCacheKey,
} from "./isr-keys.ts";

/**
 * The fleet-shared `caches.default` (`CELLD_CACHE_SCOPE=deployment` puts every
 * script of the fleet's deployment in one cache, like a Cloudflare zone), or
 * null when the runtime has no Cache API. `ProxyDeps.edgeCache` overrides
 * this in tests.
 */
const readDefaultCache = (): EdgeCache | null => {
  // SAFETY: every Cache API host exposes `caches.default` when `caches`
  // exists; both are read through `?.` and a missing Cache API yields null.
  const storage = (globalThis as { caches?: { default?: EdgeCache } }).caches;

  return storage?.default ?? null;
};

/**
 * Split a full ISR KV key into deployment id, host and key path. Null for
 * anything that is not `<v3-prefix><did>/<host>/<path>[#rw=<token>]`
 * (registry keys, malformed keys).
 */
const splitIsrKeyName = (
  key: string
): { deploymentId: string; host: string; keyPath: string } | null => {
  if (!key.startsWith(ISR_V3_PREFIX)) {
    return null;
  }

  const tail = key.slice(ISR_V3_PREFIX.length);
  const didSlash = tail.indexOf("/");

  if (didSlash === -1) {
    return null;
  }

  const hostSlash = tail.indexOf("/", didSlash + 1);

  if (hostSlash === -1) {
    return null;
  }

  const keyPath = tail.slice(hostSlash + 1);

  if (keyPath.length === 0) {
    return null;
  }

  return {
    deploymentId: tail.slice(0, didSlash),
    host: tail.slice(didSlash + 1, hostSlash),
    keyPath,
  };
};

/**
 * Delete one ISR KV key plus its html and json `caches.default` entries,
 * mirroring Void's self-host `purgeKey` (Void
 * `packages/void/src/runtime/isr.ts`): the deployment id, host and variant
 * token come from the KV key name, and a degraded Cache API never fails the
 * KV purge. Keys with no derivable edge URL (host-registry keys, malformed
 * keys) delete from KV only.
 */
const purgeIsrKey = async (
  kv: IsrKvNamespace,
  cache: EdgeCache | null,
  key: string
): Promise<void> => {
  await kv.delete(key);

  const split = splitIsrKeyName(key);

  if (!split || !cache) {
    return;
  }

  // The two edge deletes are independent attempts: unlike Void's self-host
  // `purgeKey`, which wraps both in one try, a failed html delete must not
  // skip the json delete (and vice versa) — otherwise the surviving variant
  // serves stale indefinitely with the key counted as purged. Same URLs,
  // still best effort: a degraded Cache API never fails the KV purge.
  let htmlUrl: string;
  let jsonUrl: string;

  try {
    const { normalizedPath, variantToken } = splitIsrCacheKey(split.keyPath);
    const path = denormalizeIsrPath(normalizedPath);

    htmlUrl = isrEdgeCacheUrlForToken(
      split.host,
      path,
      split.deploymentId,
      "html",
      variantToken
    );
    jsonUrl = isrEdgeCacheUrlForToken(
      split.host,
      path,
      split.deploymentId,
      "json",
      variantToken
    );
  } catch {
    // Best effort: an underivable edge URL must not fail the KV purge.
    return;
  }

  try {
    await cache.delete(htmlUrl);
  } catch {
    // Best effort (see above), but loud: a swallowed edge failure serves
    // stale L1 as fresh, and the fleet log is the only signal.
    console.error("isr edge purge failed:", sanitizeForLog(htmlUrl));
  }

  try {
    await cache.delete(jsonUrl);
  } catch {
    console.error("isr edge purge failed:", sanitizeForLog(jsonUrl));
  }
};

/**
 * Delete every key under a prefix (cursor-paginated), returning the count.
 * Used for `all: true` (ISR entries plus the host registry, across all
 * deployment ids — old-deployment keys are orphans, so this also GCs them).
 * ISR keys purge their edge entries too; registry keys have none.
 */
const deletePrefix = async (
  kv: IsrKvNamespace,
  cache: EdgeCache | null,
  prefix: string
): Promise<number> => {
  let purged = 0;
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- cursor-chained pagination: each page needs the previous cursor
    const page = await kv.list({ cursor, prefix });

    // Keys in a page are independent: delete them concurrently.
    // oxlint-disable-next-line eslint/no-await-in-loop -- page barrier before advancing the cursor
    await Promise.all(page.keys.map((key) => purgeIsrKey(kv, cache, key.name)));
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
  const split = splitIsrKeyName(key);

  if (!split) {
    return false;
  }

  return wanted.has(splitIsrCacheKey(split.keyPath).normalizedPath);
};

/**
 * The purge request as one closed union, decoded once before any KV work.
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> All: body.all === true
 *     [*] --> Empty: no usable paths
 *     [*] --> Paths: at least one normalized path
 *     All --> done: purge ISR + host registry prefixes
 *     Paths --> done: scan and purge matching keys
 *     Empty --> done: { ok: true, purged: 0 } (no-op success)
 * ```
 *
 * `All` wins over `paths` (the historical behavior): `all: true` with paths
 * purges everything. Non-string paths are dropped; unparseable-but-string
 * paths still normalize and simply match nothing.
 */
type PurgeRequest =
  | { readonly _tag: "All" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Paths"; readonly paths: ReadonlySet<string> };

const readPurgeRequest = (body: Record<string, unknown>): PurgeRequest => {
  if (body.all === true) {
    return { _tag: "All" };
  }

  const pathsRaw = Array.isArray(body.paths) ? body.paths : [];

  const paths = new Set(
    pathsRaw
      .filter((p): p is string => typeof p === "string")
      .map(normalizeIsrPath)
  );

  return paths.size === 0 ? { _tag: "Empty" } : { _tag: "Paths", paths };
};

export const handleRevalidate = async (
  isr: Subsystem<IsrKvNamespace>,
  body: Record<string, unknown>,
  deps: ProxyDeps = {}
): Promise<Response> => {
  if (isr._tag !== "Ready") {
    return json({ error: "isr cache not configured" }, 502);
  }

  const kv = isr.value;
  const request = readPurgeRequest(body);

  if (request._tag === "Empty") {
    return json({ ok: true, purged: 0 });
  }

  const cache = deps.edgeCache ?? readDefaultCache();

  try {
    let purged = 0;

    if (request._tag === "All") {
      purged += await deletePrefix(kv, cache, ISR_V3_PREFIX);
      purged += await deletePrefix(kv, cache, ISR_HOST_REGISTRY_PREFIX);
    } else {
      let cursor: string | undefined;

      do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- cursor-chained pagination: each page needs the previous cursor
        const page = await kv.list({ cursor, prefix: ISR_V3_PREFIX });

        const matched = page.keys.filter((key) =>
          isrKeyMatchesPaths(key.name, request.paths)
        );

        // Matched keys are independent: delete them concurrently.
        // oxlint-disable-next-line eslint/no-await-in-loop -- page barrier before advancing the cursor
        await Promise.all(
          matched.map((key) => purgeIsrKey(kv, cache, key.name))
        );
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
