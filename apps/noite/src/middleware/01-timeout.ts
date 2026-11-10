/**
 * The 15 s per-route bound (formerly Oxide's `actions.timeout` in
 * `vite.config.ts`; Void has no action timeout): a stuck handler answers a
 * JSON 504 before the edge's 30 s timeout, instead of hanging into the
 * platform request deadline.
 *
 * Whether a path is bounded is one explicit decision ({@link routeTimeout}),
 * not a substring hunt: a stream is a path that *ends* in `/stream` (plus
 * the multiplexing `/api/streams`), and a download is the R2 object routes
 * under `/storage/` or the source archive (`…/archive`). A JSON action whose
 * name merely contains `/stream` (e.g. `…/streamSomething`) is bounded like
 * any other action.
 *
 * Exempt: SSE streams and streaming downloads — bounding them would cut a
 * healthy long-lived response.
 */
import { defineMiddleware } from "void";

/** Bound every bounded route: a hung handler fails fast, never hangs. */
export const TIMEOUT_MS = 15_000;

/** How one path is bounded. One closed type; `routeTimeout` is the only
 * function that decides it. */
export type RouteTimeout =
  | { readonly kind: "bounded"; readonly ms: number }
  | { readonly kind: "exempt"; readonly why: "download" | "stream" };

/** Why `path` is exempt, or `null` when it is bounded. */
const exemptWhy = (path: string): "download" | "stream" | null => {
  if (path === "/api/streams" || path.endsWith("/stream")) {
    return "stream";
  }

  if (path.startsWith("/storage/") || path.endsWith("/archive")) {
    return "download";
  }

  return null;
};

/** The one timeout decision for a request path. */
export const routeTimeout = (
  path: string,
  boundedMs: number = TIMEOUT_MS
): RouteTimeout => {
  const why = exemptWhy(path);

  return why === null
    ? { kind: "bounded", ms: boundedMs }
    : { kind: "exempt", why };
};

/** A timeout gate with an explicit bound (the default export uses {@link TIMEOUT_MS}). */
export const timeoutMiddleware = (ms: number) =>
  defineMiddleware(async (c, next) => {
    const bound = routeTimeout(c.req.path, ms);

    if (bound.kind === "exempt") {
      return next();
    }

    const timeout = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => timeout.resolve("timeout"), bound.ms);

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
