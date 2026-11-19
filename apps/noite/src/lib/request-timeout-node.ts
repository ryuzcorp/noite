/**
 * Server-only half of the per-request abort (`request-timeout.ts` is the
 * client-safe contract): the real `AsyncLocalStorage` backend, registered
 * once at import. Imported for its side effect by the timeout middleware —
 * and nowhere else — so the browser bundle never sees a `node:` import.
 * Every runtime this worker executes under implements it natively except
 * the browser: Cello resolves `node:async_hooks` to real storage over V8
 * continuation-preserved embedder data (the same primitive workerd's
 * `AsyncContextFrame` rides), and the dev server (Node) and `bun test` both
 * implement it natively. Void's worker build externalizes `node:*` imports,
 * so this stays an external in the shipped bundle Cello loads.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { setRequestTimeoutBackend } from "./request-timeout";

/** The bound request's signal, strictly per request: concurrent same-isolate
 * requests are isolated by construction, with no ambient global to clear. */
const store = new AsyncLocalStorage<AbortSignal>();

setRequestTimeoutBackend({
  getStore: () => store.getStore(),
  run: <T>(signal: AbortSignal, fn: () => T): T => store.run(signal, fn),
});
