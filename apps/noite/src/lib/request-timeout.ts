/* eslint-disable max-classes-per-file -- the bound's and the disconnect's quiet abort reasons live with the store they abort through */
/**
 * The per-request abort behind the route bound (`middleware/01-timeout.ts`):
 * one `AbortController` per bounded request, aborted with a typed reason when
 * the bound fires. Downstream work observes it through the `AsyncLocalStorage`
 * store below — strictly per request, so overlapping requests can never see
 * each other's bound — and every outbound call is covered without threading a
 * signal through each action and each of the hundred `runner*` helpers.
 *
 * Wiring (one mechanism, two touch points, no per-route boilerplate):
 * - the timeout middleware runs the whole downstream pipeline inside
 *   {@link runWithRequestTimeout} with the bound request's signal;
 * - `runnerFetch` (`lib/runner.ts`) combines that signal into every runner
 *   call, and the hand-rolled forwards (`http/routes/source.ts`,
 *   `http/routes/ingest.ts`) combine it into theirs.
 *
 * The store works on every runtime this worker executes under: celld resolves
 * `node:async_hooks` to real `AsyncLocalStorage` over V8
 * continuation-preserved embedder data (the same primitive workerd's
 * `AsyncContextFrame` rides), and the dev server (Node) and `bun test` both
 * implement it natively. Void's worker build externalizes `node:*` imports,
 * so the import below stays an external in the bundle celld loads. There is
 * no ambient global slot: concurrent same-isolate requests are isolated by
 * construction, and outside a request (a CLI probe, a bare unit test)
 * `getRequestTimeoutSignal` is simply `undefined`.
 *
 * Semantics:
 * - After the 504, no further outbound runner call starts for that request:
 *   a fetch started under an already-aborted signal rejects without
 *   dispatching any I/O — no further outbound call starts — and an
 *   in-flight fetch rejects on the abort. (A runner-side write that already
 *   landed before the abort still stands — the abort stops our side waiting,
 *   it cannot un-apply the runner's — which is why a retry after a 504 can
 *   still double-apply a write the first attempt already committed. The
 *   bound narrows that window from "the whole stuck handler" to the bound
 *   itself.)
 * - A D1 transaction in progress completes atomically, never half-applies:
 *   the control plane runs no interactive transactions (D1 over HTTP has
 *   none), so every control write is one statement or one `db.batch`, and
 *   D1 applies each atomically. The abort only stops our side waiting for
 *   the answer; there is nothing to roll back.
 * - Exempt routes (streams, downloads, static) never enter the store, so
 *   their long-lived responses are untouched.
 * - A client disconnect aborts through the same controller with a typed
 *   {@link ClientDisconnectError} (not the platform's bare `AbortError`), so
 *   the funnels can tell "the caller went away" from "the call broke" and
 *   end the orphaned run quietly. When the platform never fires the raw
 *   request signal (a test `Request`, a proxy that buffers), that leg simply
 *   never fires — the bound still does.
 * - There are no Effect fibers to interrupt: the actions are plain `async`
 *   functions (no `Effect.run*` anywhere under `lib/server/` or
 *   `http/routes/`), so the `AbortSignal` below IS the interruption
 *   mechanism.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The abort reason the bound fires with. Typed (not a bare string) so
 * catch sites branch on it instead of parsing English. */
export class RequestTimeoutError extends Error {
  readonly boundMs: number;

  constructor(boundMs: number) {
    super(`Request timed out after ${boundMs} ms`);

    this.name = "RequestTimeoutError";
    this.boundMs = boundMs;
  }
}

/** The abort reason a client disconnect fires with. Typed like the bound's
 * reason, so a gone caller ends its orphaned run quietly instead of logging
 * an "Internal error" for a platform `AbortError` nobody can act on. */
export class ClientDisconnectError extends Error {
  constructor() {
    super("Client disconnected");

    this.name = "ClientDisconnectError";
  }
}

/** The bound request's signal, strictly per request. */
const store = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` under the bound request's `signal`: everything `fn` schedules —
 * the whole downstream middleware and handler pipeline, including the
 * `await`s — observes it through {@link getRequestTimeoutSignal}. */
export const runWithRequestTimeout = <T>(signal: AbortSignal, fn: () => T): T =>
  store.run(signal, fn);

/** The bound request's signal for the current run, or `undefined` on an
 * exempt route or outside a request entirely (e.g. a CLI probe). */
export const getRequestTimeoutSignal = (): AbortSignal | undefined =>
  store.getStore();

/** Fold the request bound into a call's own signal. Absent a bound (an
 * exempt route, or outside a request entirely) the call's own signal passes
 * through untouched, so unbounded callers never pay for a signal they did
 * not ask for. */
export const withRequestTimeout = (
  signal: AbortSignal | undefined
): AbortSignal | undefined => {
  const request = getRequestTimeoutSignal();

  if (request === undefined) {
    return signal;
  }

  if (signal === undefined) {
    return request;
  }

  return AbortSignal.any([request, signal]);
};

/** The typed quiet reason when it caused this failure: `signal` is the
 * signal the call captured at fetch time. `undefined` for any other failure
 * (including the call's own timeout) — those keep their existing
 * classification. A fired bound or a fired disconnect means the route's
 * answer is already moot, so mapping it here is always the quiet response,
 * never a masked error. */
export const requestTimeoutCause = (
  signal: AbortSignal | undefined
): RequestTimeoutError | ClientDisconnectError | undefined => {
  if (signal === undefined || !signal.aborted) {
    return undefined;
  }

  const reason: unknown = signal.reason;

  return reason instanceof RequestTimeoutError ||
    reason instanceof ClientDisconnectError
    ? reason
    : undefined;
};
