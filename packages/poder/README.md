# @noitenow/poder

In-pod Cloudflare Workers runtime for Noite Preview: **D1, R2, KV and Durable Objects** over local files, so a Worker can run inside a Nodepod pod where miniflare/workerd cannot (native binary, no WASM build).

```ts
import { createPoder, readBindings } from "@noitenow/poder";

const poder = await createPoder({
  stateDir: "/home/.noite/preview/state",
  projectDir: "/home/project",
  bindings: readBindings(wranglerJson),
  workerModule: await import("./worker-entry.js"),
});
const response = await poder.fetch(request);
// ...
await poder.dispose();
```

The `cloudflare:workers` shim lives at `@noitenow/poder/cloudflare-workers` (`DurableObject`, `WorkerEntrypoint`, `RpcTarget`, `env`, `waitUntil`, `WebSocketPair`). `createPoder` wires the live env through `globalThis`, so the shim works whether it is bundled with the worker entry or loaded as the separate `dist/cloudflare-workers.mjs` file next to it.

## Layout

All binding data lives under `stateDir`:

- `db/d1-<16hex>.sqlite` — one SQLite file per D1 database
- `db/kv-<16hex>.sqlite` — one SQLite file per KV namespace
- `db/do-<16hex>.sqlite` — one SQLite file per Durable Object
- `db/index.json` — debug map from file to `{kind, binding, name}`
- `r2/<bucket>/…` — object bytes plus a `.poder.json` sidecar per object

Database files are flat with fixed-length names because the pod's SQLite refuses database paths longer than 56 chars: the 16 hex chars hash kind+binding+name (NUL-joined SHA-256), so every database path has the same length and only `stateDir` varies — keep `stateDir` short (with `/home/.noite/s` every database path is 44 chars). Delete the directory (or a single file) to reset that binding. Data survives process restarts: files are only read/written, never held in memory.

## What's supported

- **D1**: `prepare/bind/first/all/run/raw`, `batch` (single transaction with rollback), `exec`, `withSession` (returns the database itself). `D1Result.meta` carries `changes`, `last_row_id`, `duration`, `rows_read`, `rows_written`, `changed_db`, `size_after`. Migrations: `*.sql` files from `migrations_dir` (default `migrations/`, resolved against `projectDir`) applied in sorted order, tracked in `d1_migrations` (wrangler's table), once per database. `dump()` throws — it is not available in Preview.
- **R2**: `put` (string, buffers, Blob, ReadableStream, null; `httpMetadata`, `customMetadata`, `md5`/`sha1`/`sha256`/`sha512` verification, `onlyIf`), `get` (offset/length and suffix ranges, conditional `onlyIf` answering an object without a body), `head`, `delete` (one or many keys), `list` (`prefix`, `delimiter` → `delimitedPrefixes`, `cursor`, `limit` ≤ 1000), multipart uploads (`createMultipartUpload`, `resumeMultipartUpload`, `uploadPart`, `complete`, `abort`).
- **KV**: `get` (`text`/`json`/`arrayBuffer`/`stream`; `cacheTtl` accepted and ignored), `getWithMetadata`, `put` (`expiration`/`expirationTtl`/`metadata`), `delete`, `list` (`prefix`, `cursor`, `limit`).
- **Durable Objects**: `idFromName` (deterministic SHA-256), `newUniqueId`, `idFromString`, `get`/`getByName`, `jurisdiction` (no-op). Stubs expose `fetch()` plus direct RPC methods (args/results go through `structuredClone`). Storage offers the KV API (`get`/`put`/`delete` single, batch and map forms, `list` with start/startAfter/end/prefix/ reverse/limit, `deleteAll`), `transaction`/`transactionSync` with rollback, `getAlarm`/`setAlarm`/`deleteAlarm` (alarms survive restarts: they are re-armed from storage on next use), and raw `storage.sql.exec/query` on the same file.
- **WebSockets**: `WebSocketPair` with `accept()`/`send()`/`close()` and `message`/`close` events. The client side starts open; the server side queues inbound messages until `accept()` (called by `ctx.acceptWebSocket`), mirroring Cloudflare's accept semantics.

## What's approximate

- **Single location**: no regions, no `jurisdiction` enforcement.
- **Input gate, simplified**: one call per object runs at a time end to end. Cloudflare allows interleaving at await boundaries within the gate; poder serializes the whole handler instead. Concurrent transactions on one object's storage therefore cannot interleave mid-flight.
- **No output gates**: `waitUntil` work is collected and settled on `dispose()`; it does not extend any lifetime.
- **D1 meta is best-effort**: `rows_read` counts returned rows, `rows_written` mirrors `changes`, `size_after` is the file size after the statement. `withSession` returns the database itself (no session isolation).
- **R2**: no real ETag semantics beyond content MD5, no storage classes, multipart parts live on disk until completed/aborted.
- **DO storage values** are JSON-encoded with binary/Date/Map/Set preservation; non-structured-cloneable values (functions, class instances, streams) do not survive a round trip.
- **No real network upgrade**: a `Response` carrying a WebSocket (status 101) cannot be constructed outside Cloudflare; drive the pair directly instead.
- **Not implemented** (each throws `Error("… is not available in Preview")` where reachable): service bindings to other Workers, Queues, Hyperdrive, Vectorize, AI, Analytics Engine, Browser Rendering, Workflows, secrets store.

## SQLite drivers

The default driver uses `node:sqlite` (`DatabaseSync`) and runs on Node ≥ 22 and inside the Nodepod pod (the integration calls the pod's `preloadSqlite()` before importing). Inject a custom `SqliteDriver` for anything else — the test suite uses a `bun:sqlite` adapter, see `tests/driver.ts`.
