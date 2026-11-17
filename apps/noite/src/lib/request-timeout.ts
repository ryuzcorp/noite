/**
 * The per-request abort behind the route bound (`middleware/01-timeout.ts`):
 * one `AbortController` per bounded request, aborted with a typed reason when
 * the bound fires. Downstream work observes it through the ambient stamp
 * below — the same stamp pattern `control-env` and the D1 binding use — so
 * every outbound call is covered without threading a signal through each
 * action and each of the hundred `runner*` helpers.
 *
 * Wiring (one mechanism, two touch points, no per-route boilerplate):
 * - the timeout middleware stamps the bound request's signal for the whole
 *   downstream run and aborts it when the bound fires;
 * - `runnerFetch` (`lib/runner.ts`) combines that signal into every runner
 *   call, and the hand-rolled forwards (`http/routes/source.ts`,
 *   `http/routes/ingest.ts`) combine it into theirs.
 *
 * Semantics:
 * - After the 504, no further outbound runner call starts for that request:
 *   a fetch started under an already-aborted signal rejects without
 *   dispatching any I/O, and an in-flight fetch rejects on the abort. (A
 *   runner-side write that already landed before the abort still stands —
 *   the abort stops our side waiting, it cannot un-apply the runner's —
 *   which is why a retry after a 504 can still double-apply a write the
 *   first attempt already committed. The bound narrows that window from
 *   "the whole stuck handler" to "the bound itself".)
 * - A D1 transaction in progress completes atomically, never half-applies:
 *   the control plane runs no interactive transactions (D1 over HTTP has
 *   none), so every control write is one statement or one `db.batch`, and
 *   D1 applies each atomically. The abort only stops our side waiting for
 *   the answer; there is nothing to roll back.
 * - Exempt routes (streams, downloads, static) never get a controller, so
 *   the stamp stays empty for them and their long-lived responses are
 *   untouched.
 * - A client disconnect aborts through the same controller: the middleware
 *   forwards the raw request signal's abort into it. When the platform never
 *   fires the raw signal (a test `Request`, a proxy that buffers), that leg
 *   simply never fires — the bound still does.
 * - There are no Effect fibers to interrupt: the actions are plain `async`
 *   functions (no `Effect.run*` anywhere under `lib/server/` or
 *   `http/routes/`), so the `AbortSignal` below IS the interruption
 *   mechanism.
 *
 * Concurrency: the stamp is one ambient slot, last-writer-wins across
 * same-isolate requests (exactly like the control-env stamp). A fetch
 * captures the signal present when it starts, so the failure mode under
 * overlap is fail-safe — a fetch may observe another request's bound and
 * abort early — never a missed abort of its own timeout.
 */

/** Context-var key the middleware publishes the bound signal under. */
export const REQUEST_TIMEOUT_SIGNAL_KEY = "requestTimeoutSignal";

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

let current: AbortSignal | undefined;

/** The bound request's signal for the downstream run, or `undefined` on an
 * exempt route (or outside a request entirely, e.g. a CLI probe). */
export const getRequestTimeoutSignal = (): AbortSignal | undefined => current;

/** Stamp `signal` for the downstream run. The middleware is the only
 * stamper; it always pairs this with {@link clearRequestTimeoutSignal} in a
 * `finally`. */
export const stampRequestTimeoutSignal = (signal: AbortSignal): void => {
  current = signal;
};

/** Release the stamp, but only when it is still ours: a concurrent request
 * may have stamped over us, and clearing blindly would drop its bound. */
export const clearRequestTimeoutSignal = (signal: AbortSignal): void => {
  if (current === signal) {
    current = undefined;
  }
};

/** Fold the ambient request bound into a call's own signal. Absent a bound
 * (exempt route, no stamper) the call's own signal passes through untouched,
 * so unbounded callers never pay for a signal they did not ask for. */
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

/** The bound's typed reason when it caused this failure: `signal` is the
 * ambient signal the call captured at fetch time. `undefined` for any other
 * failure (including the call's own timeout) — those keep their existing
 * classification. A fired bound means the route already answered, so mapping
 * it here is always the quiet 504, never a masked error. */
export const requestTimeoutCause = (
  signal: AbortSignal | undefined
): RequestTimeoutError | undefined => {
  if (signal === undefined || !signal.aborted) {
    return undefined;
  }

  const reason: unknown = signal.reason;

  return reason instanceof RequestTimeoutError ? reason : undefined;
};
