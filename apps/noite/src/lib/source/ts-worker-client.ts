//! The one place the language-service worker is spawned.
//!
//! `new Worker(new URL(…, import.meta.url), { type: "module" })` is the shape
//! Vite rewrites into a real module worker: in dev it serves `ts-worker.ts` as
//! a module entry; in a build it emits a separate chunk
//! (`assets/ts-worker-*.js`, a few MB of TypeScript) that is fetched only when
//! the first TS/JS file opens. Keeping the call in its own module means the
//! rest of the client never mentions the worker URL, and `vite.config.ts` can
//! stub this module out of the ssr environment.

/** Spawn the worker. Never called on the server. */
export const createIntelWorker = (): Worker =>
  new Worker(new URL("ts-worker.ts", import.meta.url), {
    name: "noite-ts",
    type: "module",
  });
