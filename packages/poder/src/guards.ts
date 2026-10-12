// Canonical runtime guards for untyped driver, config and storage values.
// Type predicates are the named-boundary pattern: `typeof` inside them is
// exempt from the runtime-typeof rule by config.

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- canonical record guard: untyped driver/config/storage values narrow through here.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isBigint = (value: unknown): value is bigint =>
  typeof value === "bigint";

export const isFunction = (
  value: unknown
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: narrowed callables resolve arbitrary values; callers name the result.
): value is (...args: unknown[]) => unknown => typeof value === "function";

export const isVarValue = (
  value: unknown
): value is string | number | boolean | object =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (typeof value === "object" && value !== null);
