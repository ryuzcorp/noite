/**
 * The 15 s per-route bound (formerly Oxide's `actions.timeout` in
 * `vite.config.ts`; Void has no action timeout): a stuck handler answers a
 * JSON 504 before the edge's 30 s timeout, instead of hanging into the
 * platform request deadline.
 *
 * Whether a path is bounded is one explicit decision ({@link routeTimeout}),
 * not a substring hunt: a stream is a path that *ends* in `/stream` (plus
 * the multiplexing `/api/streams`), a download is the R2 object routes under
 * `/storage/`, and a static file is the fingerprinted client bundle under
 * `/assets/`. A JSON action whose
 * name merely contains `/stream` (e.g. `…/streamSomething`) is bounded like
 * any other action.
 *
 * Exempt: SSE streams, streaming downloads and static files — bounding a
 * stream or a download would cut a healthy long-lived response, and bounding
 * a static file is worse than useless: the 504 is JSON, so a bundle that
 * outlives the bound never executes and the page never hydrates (the e2e
 * "flake wave": a chunk 504'd at exactly 15 s, then every locator on the
 * un-hydrated page timed out 30 s later). celld serves `/assets/*` itself
 * (`RUN_WORKER_FIRST` in `void.config.ts` excludes it), so this exemption
 * covers the paths that still reach the Worker: a missing file's fall
 * through, and a direct-to-worker request.
 *
 * `/mcp` carries its own, longer bound: one `tools/call` may deliberately wait
 * (`wait_for_deploy`, capped at 60 s), so the action bound would cut a healthy
 * answer into a 504 the caller cannot read.
 */
import { defineMiddleware } from "void";

/** Bound every bounded route: a hung handler fails fast, never hangs. */
export const TIMEOUT_MS = 15_000;

/** The MCP endpoint's bound: `wait_for_deploy`'s 60 s cap plus the write it
 * answers with. The edge has no response deadline of its own (Caddy's
 * progress-based `write_idle` is 1 m, and this answers inside it). */
export const MCP_TIMEOUT_MS = 65_000;

/** How one path is bounded. One closed type; `routeTimeout` is the only
 * function that decides it. */
export type RouteTimeout =
  | { readonly kind: "bounded"; readonly ms: number }
  | { readonly kind: "exempt"; readonly why: "download" | "static" | "stream" };

/** Why `path` is exempt, or `null` when it is bounded. */
const exemptWhy = (path: string): "download" | "static" | "stream" | null => {
  if (path === "/api/streams" || path.endsWith("/stream")) {
    return "stream";
  }

  if (path.startsWith("/storage/")) {
    return "download";
  }

  if (path.startsWith("/assets/")) {
    return "static";
  }

  return null;
};

/** The one timeout decision for a request path. `boundedMs` is the action
 * bound; `/mcp` answers on its own bound because a tool call may wait on
 * purpose ({@link MCP_TIMEOUT_MS}). */
export const routeTimeout = (
  path: string,
  boundedMs: number = TIMEOUT_MS
): RouteTimeout => {
  if (path === "/mcp") {
    return { kind: "bounded", ms: MCP_TIMEOUT_MS };
  }

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
