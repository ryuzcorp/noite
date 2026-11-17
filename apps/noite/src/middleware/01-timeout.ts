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
 *
 * The bound aborts the downstream work, not just the response: each bounded
 * request gets an `AbortController`, and the whole downstream pipeline runs
 * inside that signal's `AsyncLocalStorage` store (see
 * `lib/request-timeout.ts`) — strictly per request, so overlapping requests
 * never observe each other's bound. The signal is aborted with a typed
 * `RequestTimeoutError` when the bound fires. `runnerFetch` folds that
 * signal into every runner call, so after the 504 no further outbound runner
 * call starts for that request and in-flight ones reject. A slow write that
 * already reached the runner still stands — the abort stops our side
 * waiting, it cannot un-apply the runner's — which is why a retry after a
 * 504 can double-apply a write the first attempt already committed; the
 * bound narrows that window from "the whole stuck handler" to the bound
 * itself. D1 needs no rollback: the control plane runs no interactive
 * transactions, so every control write is one statement or one `db.batch`,
 * and D1 applies each atomically. Exempt routes never get a controller and
 * are unaffected. A client disconnect aborts through the same controller
 * with a typed `ClientDisconnectError`, so a gone client stops its
 * downstream the same way — and quietly, not as an "Internal error".
 */
import { defineMiddleware } from "void";

import {
  ClientDisconnectError,
  RequestTimeoutError,
  runWithRequestTimeout,
} from "../lib/request-timeout";

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

/** A timeout gate with an explicit bound (the default export uses {@link TIMEOUT_MS}).
 * A bounded request runs under its own `AbortController`: the whole
 * downstream pipeline runs inside the request's `AsyncLocalStorage` store
 * (see `lib/request-timeout.ts`) and the signal is aborted with a typed
 * reason when the bound fires, so the slow write behind the 504 stops
 * instead of double-applying on retry. A client disconnect aborts with a
 * typed reason through the same controller. */
export const timeoutMiddleware = (ms: number) =>
  defineMiddleware(async (c, next) => {
    const bound = routeTimeout(c.req.path, ms);

    if (bound.kind === "exempt") {
      return next();
    }

    const controller = new AbortController();
    const raw = c.req.raw.signal;

    const onDisconnect = (): void => {
      controller.abort(new ClientDisconnectError());
    };

    if (raw.aborted) {
      onDisconnect();
    } else {
      raw.addEventListener("abort", onDisconnect, { once: true });
    }

    const timeout = Promise.withResolvers<"timeout">();

    const timer = setTimeout(() => {
      controller.abort(new RequestTimeoutError(bound.ms));
      timeout.resolve("timeout");
    }, bound.ms);

    try {
      const winner = await runWithRequestTimeout(controller.signal, () =>
        Promise.race([
          // oxlint-disable-next-line node/callback-return -- Hono's next() resolves the downstream pipeline (not a Node callback); the race — not a return — settles the response.
          next().then((): "done" => "done"),
          timeout.promise,
        ])
      );

      if (winner === "timeout") {
        return c.json({ error: "Request timed out" }, 504);
      }
    } finally {
      clearTimeout(timer);
      raw.removeEventListener("abort", onDisconnect);
    }
  });

export default timeoutMiddleware(TIMEOUT_MS);
