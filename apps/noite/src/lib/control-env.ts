/** Shared Oxide env bag (must be a plain object — process.env stringifies values). */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
export const controlEnv: Record<string, unknown> = {};

export const hydrateControlEnv = (
  // SAFETY: defaulting to process.env crashes on Workers (no process) — guard with typeof, which is safe on undefined globals.
  from:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = typeof process === "undefined"
    ? {}
    : process.env
) => {
  for (const [key, value] of Object.entries(from)) {
    if (
      value !== undefined &&
      // SAFETY: durable bindings are pre-built plain objects (already hydrated); overwriting them from process.env would wipe the binders, so only string primitives are refreshed here.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      typeof controlEnv[key] !== "object"
    ) {
      controlEnv[key] = value;
    }
  }
  const defaults = {
    AWS_REGION: "us-east-1",
    BASE_DOMAIN: "localhost",
    RUNNER_URL: "http://runner:8080",
    S3_ENDPOINT: "http://rustfs:9000",
    S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9000",
  } satisfies Record<string, string>;
  for (const [key, value] of Object.entries(defaults)) {
    if (controlEnv[key] === undefined) {
      controlEnv[key] = value;
    }
  }
  if (!controlEnv.AWS_ACCESS_KEY_ID && from.RUSTFS_ACCESS_KEY) {
    controlEnv.AWS_ACCESS_KEY_ID = from.RUSTFS_ACCESS_KEY;
  }
  if (!controlEnv.AWS_SECRET_ACCESS_KEY && from.RUSTFS_SECRET_KEY) {
    controlEnv.AWS_SECRET_ACCESS_KEY = from.RUSTFS_SECRET_KEY;
  }
  if (!controlEnv.RUSTFS_ACCESS_KEY && from.RUSTFS_ACCESS_KEY) {
    controlEnv.RUSTFS_ACCESS_KEY = from.RUSTFS_ACCESS_KEY;
  }
  if (!controlEnv.RUSTFS_SECRET_KEY && from.RUSTFS_SECRET_KEY) {
    controlEnv.RUSTFS_SECRET_KEY = from.RUSTFS_SECRET_KEY;
  }
};
