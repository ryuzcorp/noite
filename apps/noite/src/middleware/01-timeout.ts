/**
 * The 15 s per-route bound (formerly Oxide's `actions.timeout` in
 * `vite.config.ts`; Void has no action timeout): a stuck handler answers a
 * JSON 504 before the edge's 30 s timeout, instead of hanging into the
 * platform request deadline.
 *
 * Exempt: any path containing `/stream`, the R2 object routes under
 * `/storage/`, and the source archive (`.../archive`, a tar download) --
 * bounding them would cut a healthy long-lived response.
 */
import { defineMiddleware } from "void";

/** Bound every non-exempt route: a hung handler fails fast, never hangs. */
export const TIMEOUT_MS = 15_000;

/** Whether `path` skips the timeout (streams and streaming downloads). */
export const timeoutExempt = (path: string): boolean =>
  path.includes("/stream") ||
  path.startsWith("/storage/") ||
  path.endsWith("/archive");

/** A timeout gate with an explicit bound (the default export uses {@link TIMEOUT_MS}). */
export const timeoutMiddleware = (ms: number) =>
  defineMiddleware(async (c, next) => {
    if (timeoutExempt(c.req.path)) {
      return next();
    }

    const timeout = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => timeout.resolve("timeout"), ms);

    try {
      const winner = await Promise.race([
        // oxlint-disable-next-line node/callback-return -- Hono's next() resolves the downstream pipeline (not a Node callback); the race — not a return — settles the response.
        next().then((): "done" => "done"),
        timeout.promise,
      ]);

      if (winner === "timeout") {
        return c.json({ error: "Request timed out" }, 504);
      }
    } finally {
      clearTimeout(timer);
    }
  });

export default timeoutMiddleware(TIMEOUT_MS);
