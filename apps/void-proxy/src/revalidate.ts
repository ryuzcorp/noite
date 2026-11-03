/** `POST /revalidate`: KV purge across all deployment ids. */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { errorMessage, json, sanitizeForLog } from "./auth.ts";
import type { Env, IsrKvNamespace } from "./env.ts";
import {
  ISR_HOST_REGISTRY_PREFIX,
  ISR_V3_PREFIX,
  normalizeIsrPath,
  splitIsrCacheKey,
} from "./isr-keys.ts";

/**
 * Delete every key under a prefix (cursor-paginated), returning the count.
 * Used for `all: true` (ISR entries plus the host registry, across all
 * deployment ids — old-deployment keys are orphans, so this also GCs them).
 */
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

export const handleRevalidate = async (
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
