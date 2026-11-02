/**
 * ISR key helpers — ported byte-identically from Void `packages/isr/src/index.ts`
 * (writers, readers and purgers must build byte-identical keys).
 *
 * Portions ported from the Void project (MIT License — see the attribution
 * note in SPEC.md "Void platform proxy").
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

const DIRECT_ISR_PROJECT_ID = "__void_direct__";
const ISR_CACHE_KEY_VERSION = "v3";
const ISR_VARIANT_SEPARATOR = "#rw=";

/** Cross-deployment scan prefix for ISR purge (all deployment ids at once). */
export const ISR_V3_PREFIX = `${DIRECT_ISR_PROJECT_ID}/isr/${ISR_CACHE_KEY_VERSION}/`;
export const ISR_HOST_REGISTRY_PREFIX = "void-isr-hosts/";

/**
 * Build the normalized path segment for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export const normalizeIsrPath = (pathname: string): string => {
  let normalized = pathname;

  if (normalized === "/") {
    normalized = "__index__";
  } else {
    normalized = normalized.startsWith("/") ? normalized.slice(1) : normalized;

    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
  }

  return normalized;
};

/**
 * Prefix for listing/purging ISR keys. An empty `deploymentId` still yields the
 * versioned prefix, because writers may use an empty id. Only `undefined`
 * selects every key.
 */
export const isrCachePrefix = (
  projectId: string,
  deploymentId?: string
): string => {
  if (deploymentId !== undefined) {
    return `${projectId}/isr/${ISR_CACHE_KEY_VERSION}/${deploymentId}/`;
  }

  return `${projectId}/isr/`;
};

const FNV_OFFSET_BASIS = 0xcb_f2_9c_e4_84_22_23_25n;
const FNV_PRIME = 0x1_00_00_00_01_b3n;
const FNV_MASK = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/**
 * Hash an original URL into a 16-hex-char variant token (FNV-1a 64-bit).
 * Sync so it fits every read/write path; opaque so KV never exposes original
 * URLs. Not cryptographic.
 */
export const hashOriginalUrl = (originalUrl: string): string => {
  const bytes = new TextEncoder().encode(originalUrl);
  let h = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    // oxlint-disable-next-line eslint/no-bitwise -- FNV-1a is defined with xor and masked multiply
    h = (h ^ BigInt(byte)) & FNV_MASK;
    // oxlint-disable-next-line eslint/no-bitwise -- FNV-1a is defined with xor and masked multiply
    h = (h * FNV_PRIME) & FNV_MASK;
  }

  return h.toString(16).padStart(16, "0");
};

/**
 * KV key for an ISR-cached page: `<proj>/isr/v3/<D>/<host>/<path>`.
 * Pass `originalUrl` for a rewrite/query variant (`#rw=<token>` suffix).
 */
export const isrCacheKey = (
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null
): string => {
  const base = `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}`;

  if (!originalUrl) {
    return base;
  }

  return `${base}${ISR_VARIANT_SEPARATOR}${hashOriginalUrl(originalUrl)}`;
};

/** Prefix for listing the `#rw=` variant keys of a pathname (not its direct-hit key). */
export const isrCacheVariantPrefix = (
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string
): string =>
  `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;

/**
 * Split an ISR KV key into its normalized path and its `#rw=` variant token
 * (`null` for a direct hit).
 */
export const splitIsrCacheKey = (
  fullKey: string
): {
  normalizedPath: string;
  variantToken: string | null;
} => {
  const sepIdx = fullKey.indexOf(ISR_VARIANT_SEPARATOR);

  if (sepIdx === -1) {
    return { normalizedPath: fullKey, variantToken: null };
  }

  return {
    normalizedPath: fullKey.slice(0, sepIdx),
    variantToken: fullKey.slice(sepIdx + ISR_VARIANT_SEPARATOR.length),
  };
};
