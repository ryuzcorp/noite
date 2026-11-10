//! Main-thread client for the source browser's TypeScript intelligence.
//!
//! The compiler itself (TypeScript 5.x, aliased `typescript-ls`) plus its own
//! lib `.d.ts` files ship in `ts-worker.ts`, a module worker created on first
//! use — never in the main bundle (see the note in `ts-worker-client.ts`).
//! This module is only the client: request/response plumbing over the wire
//! protocol in `intel-protocol.ts`. Importing `typescript-ls` from here would
//! drag ~13 MB into the main bundle, so nothing in this file may.

import { Data } from "effect";

import type {
  IntelBundle,
  IntelCompletion,
  IntelDefinition,
  IntelDiagnostic,
  IntelFile,
  IntelMessage,
  IntelQuickInfo,
  IntelRequest,
  IntelResult,
} from "./intel-protocol";
import { createIntelWorker } from "./ts-worker-client";

/** What the intelligence client is doing.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> idle
 *   idle --> loading: sync / reset
 *   loading --> ready: the snapshot was installed
 *   loading --> idle: the bundle or the worker failed (retry on next open)
 *   ready --> broken: the worker died
 *   broken --> loading: the next request restarts it
 *   idle --> disposed: dispose
 *   ready --> disposed: dispose
 *   broken --> disposed: dispose
 * ```
 *
 * `broken` used to be permanent: the error handler dropped the worker but left
 * the started promise resolved, so every later request answered `null` and the
 * pane silently lost diagnostics, hover and definition for the rest of the
 * mount. A broken client now restarts from its last inputs on the next
 * request. */
export type IntelState = Data.TaggedEnum<{
  Broken: { message: string };
  Disposed: Record<never, never>;
  Idle: Record<never, never>;
  Loading: Record<never, never>;
  Ready: Record<never, never>;
}>;

export type IntelEvent =
  | { message: string; t: "broken" }
  | { t: "dispose" }
  | { message: string; t: "failed" }
  | { t: "loaded" }
  | { t: "start" };

export const Intel = Data.taggedEnum<IntelState>();

/** The one client transition. `disposed` is terminal; `ready` is only reached
 * after the worker acknowledged the snapshot. */
export const intelTransition = (
  state: IntelState,
  event: IntelEvent
): IntelState => {
  if (event.t === "dispose") {
    return Intel.Disposed();
  }

  return Intel.$match(state, {
    Broken: () => (event.t === "start" ? Intel.Loading() : state),
    Disposed: () => state,
    Idle: () => (event.t === "start" ? Intel.Loading() : state),
    Loading: () => {
      switch (event.t) {
        case "broken": {
          return Intel.Broken({ message: event.message });
        }

        case "failed": {
          return Intel.Idle();
        }

        case "loaded": {
          return Intel.Ready();
        }

        default: {
          return state;
        }
      }
    },
    Ready: () =>
      event.t === "broken" ? Intel.Broken({ message: event.message }) : state,
  });
};

interface IntelPending {
  reject: (error: Error) => void;
  resolve: (value: IntelResult) => void;
}

/** TypeScript intelligence for one browser mount.
 *
 * The worker is created on the first `sync` (the first TS/JS file opened) and
 * holds the virtual FS: repository sources at the browsing ref, every draft the
 * editor hands over, and the package declarations it fetches from esm.sh
 * itself. Requests never wait on the network — they wait on the worker's own
 * sync, which the caller starts (and restarts after a push). Declarations that
 * arrive later come back as a `typesChanged` event, which `onTypesChanged`
 * turns into a fresh check of the open file. */
export class SourceIntel {
  #generation = 0;
  #pending = new Map<number, IntelPending>();
  #seq = 0;
  /** Last text handed to the worker: a request can bring the worker's copy up
   * to date with one small message instead of shipping the file every call. */
  #sent = new Map<string, string>();
  #started: Promise<void> | undefined;
  /** The last inputs a restart needs (a worker that died mid-mount). */
  #last: {
    drafts: readonly IntelFile[];
    load: () => Promise<IntelBundle>;
  } | null = null;
  #state: IntelState = Intel.Idle();
  #worker: Worker | undefined;
  readonly #onTypesChanged: (() => void) | undefined;

  constructor(onTypesChanged?: () => void) {
    this.#onTypesChanged = onTypesChanged;
  }

  /** Build the worker's program from `load`'s payload plus the current drafts.
   * Memoized: concurrent callers share one sync (a second call while the first
   * bundle is still in flight is the common case — the page opens several
   * files, or a stale open competes with a fresh one). */
  sync(
    load: () => Promise<IntelBundle>,
    drafts: readonly IntelFile[]
  ): Promise<void> {
    this.#last = { drafts, load };

    if (Intel.$is("Broken")(this.#state)) {
      this.#sent.clear();
      this.#started = undefined;
    }

    this.#started ??= this.#start(load, drafts);

    return this.#started;
  }

  /** The client's state now (see `IntelState`). */
  state(): IntelState {
    return this.#state;
  }

  /** Re-sync from scratch (a push changed the repo): the replies still in
   * flight answer a program that no longer exists, so they are dropped. */
  reset(
    load: () => Promise<IntelBundle>,
    drafts: readonly IntelFile[]
  ): Promise<void> {
    this.#last = { drafts, load };
    this.#generation += 1;
    this.#failPending(new Error("source intelligence reset"));
    this.#sent.clear();
    this.#started = this.#start(load, drafts);

    return this.#started;
  }

  /** Stop the worker and reject whatever is in flight. */
  dispose(): void {
    this.#state = intelTransition(this.#state, { t: "dispose" });
    this.#generation += 1;
    this.#failPending(new Error("source intelligence disposed"));
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#started = undefined;
  }

  async diagnostics(path: string, text: string): Promise<IntelDiagnostic[]> {
    const found = await this.#request<IntelDiagnostic[]>(path, text, (id) => ({
      id,
      kind: "diagnostics",
      path,
    }));

    return found ?? [];
  }

  quickInfo(
    path: string,
    text: string,
    offset: number
  ): Promise<IntelQuickInfo | null> {
    return this.#request<IntelQuickInfo | null>(path, text, (id) => ({
      id,
      kind: "quickInfo",
      offset,
      path,
    }));
  }

  definition(
    path: string,
    text: string,
    offset: number
  ): Promise<IntelDefinition | null> {
    return this.#request<IntelDefinition | null>(path, text, (id) => ({
      id,
      kind: "definition",
      offset,
      path,
    }));
  }

  completion(
    path: string,
    text: string,
    offset: number
  ): Promise<IntelCompletion | null> {
    return this.#request<IntelCompletion | null>(path, text, (id) => ({
      id,
      kind: "completion",
      offset,
      path,
    }));
  }

  /** One request, preceded by whatever draft update it needs. Everything is
   * best-effort: a dead or slow worker must never break the pane, so failures
   * resolve to null (diagnostics then simply stay as they were). */
  async #request<T extends IntelResult>(
    path: string,
    text: string,
    build: (id: number) => Exclude<IntelRequest, { kind: "update" }>
  ): Promise<T | null> {
    // A worker that died is restarted from the last inputs rather than left
    // broken: diagnostics, hover and definition must come back on their own.
    if (Intel.$is("Broken")(this.#state) && this.#last !== null) {
      this.#generation += 1;
      this.#sent.clear();
      this.#started = this.#start(this.#last.load, this.#last.drafts);
    }

    const generation = this.#generation;
    const ready = this.#started;

    if (!ready) {
      return null;
    }

    try {
      await ready;
    } catch {
      return null;
    }

    const worker = this.#worker;

    if (generation !== this.#generation || !worker) {
      return null;
    }

    this.#syncText(path, text);

    try {
      // SAFETY: the worker answers each id with the payload its request kind
      // asks for — `build` is what decided the kind, and `T` is the payload
      // the caller of this same call named (intel-protocol.ts).
      return (await this.#post(worker, build(this.#nextId()))) as T;
    } catch {
      return null;
    }
  }

  /** Ship the file text when the worker's copy is behind (edits change it on
   * every keystroke; hover and definition reuse the last one). Message order is
   * FIFO in the worker, so the update always lands before the request. */
  #syncText(path: string, text: string): void {
    if (this.#sent.get(path) === text) {
      return;
    }

    this.#sent.set(path, text);
    this.#worker?.postMessage({ kind: "update", path, text });
  }

  #nextId(): number {
    this.#seq += 1;

    return this.#seq;
  }

  /** Send an id-bearing request and wait for its reply. */
  #post(
    worker: Worker,
    request: Exclude<IntelRequest, { kind: "update" }>
  ): Promise<IntelResult> {
    const reply = Promise.withResolvers<IntelResult>();
    this.#pending.set(request.id, {
      reject: reply.reject,
      resolve: reply.resolve,
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin (the worker is same-origin by construction)
    worker.postMessage(request);

    return reply.promise;
  }

  async #start(
    load: () => Promise<IntelBundle>,
    drafts: readonly IntelFile[]
  ): Promise<void> {
    this.#state = intelTransition(this.#state, { t: "start" });
    // A reset or a dispose mid-sync supersedes this attempt: the catch below
    // must not clear the `#started` the newer one installed.
    const generation = this.#generation;
    const worker = this.#worker ?? this.#createWorker();
    let bundle: IntelBundle;

    try {
      bundle = await load();
    } catch {
      // The bundle fetch is the one step that fails for reasons the editor
      // cannot fix (auth, network). Forget the attempt so the next file the
      // user opens retries; until then every request answers null.
      if (generation === this.#generation) {
        this.#state = intelTransition(this.#state, {
          message: "the bundle did not load",
          t: "failed",
        });
        this.#started = undefined;
      }

      return;
    }

    this.#sent = new Map(drafts.map((draft) => [draft.path, draft.text]));

    try {
      await this.#post(worker, {
        bundle,
        drafts: [...drafts],
        id: this.#nextId(),
        kind: "sync",
      });

      if (generation === this.#generation) {
        this.#state = intelTransition(this.#state, { t: "loaded" });
      }
    } catch {
      // The worker died installing the snapshot (only reachable through its
      // own failure): same recovery as a failed load, and the worker itself is
      // dropped so the next attempt builds a live one instead of posting into
      // a scope that will never answer.
      this.#drop(worker);

      if (generation === this.#generation) {
        this.#state = intelTransition(this.#state, {
          message: "the language worker failed to install the sources",
          t: "failed",
        });
        this.#started = undefined;
      }
    }
  }

  /** Forget a worker that is dead or superseded: a `postMessage` into it is
   * never answered, so reusing it would hang every later request. */
  #drop(worker: Worker): void {
    worker.terminate();

    if (this.#worker === worker) {
      this.#worker = undefined;
    }
  }

  #createWorker(): Worker {
    const worker = createIntelWorker();
    worker.addEventListener("message", (event: MessageEvent<IntelMessage>) => {
      const message = event.data;

      if (!("id" in message)) {
        // Unsolicited: declarations landed after a reply the pane already
        // painted, so what it painted is worth re-checking.
        this.#onTypesChanged?.();

        return;
      }

      const pending = this.#pending.get(message.id);

      if (!pending) {
        return;
      }

      this.#pending.delete(message.id);

      if (message.ok) {
        pending.resolve(message.value);
      } else {
        pending.reject(new Error(message.error));
      }
    });
    worker.addEventListener("error", (event) => {
      // A worker that failed (a bad chunk, an evaluation error) never answers
      // again: it is dropped, its pending requests are refused, and the client
      // remembers it is broken so the next request restarts it.
      this.#drop(worker);
      this.#state = intelTransition(this.#state, {
        message: event.message || "language worker failed",
        t: "broken",
      });
      this.#started = undefined;
      this.#failPending(new Error(event.message || "language worker failed"));
    });
    this.#worker = worker;

    return worker;
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }

    this.#pending.clear();
  }
}
