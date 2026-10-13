//! Main-thread client for the source browser's TypeScript intelligence.
//!
//! The compiler itself (TypeScript 5.x, aliased `typescript-ls`) plus its own
//! lib `.d.ts` files ship in `ts-worker.ts`, a module worker created on first
//! use — never in the main bundle (see the note in `ts-worker-client.ts`).
//! This module is only the client: request/response plumbing over the wire
//! protocol in `intel-protocol.ts`. Importing `typescript-ls` from here would
//! drag ~13 MB into the main bundle, so nothing in this file may.

import type {
  IntelCompletion,
  IntelDefinition,
  IntelDiagnostic,
  IntelFile,
  IntelQuickInfo,
  IntelReply,
  IntelRequest,
  IntelResult,
  IntelSources,
} from "./intel-protocol";
import { createIntelWorker } from "./ts-worker-client";

interface IntelPending {
  reject: (error: Error) => void;
  resolve: (value: IntelResult) => void;
}

/** TypeScript intelligence for one browser mount.
 *
 * The worker is created on the first `sync` (the first TS/JS file opened) and
 * holds the virtual FS: repository sources at the browsing ref, the declaration
 * files captured from the last successful build, and every draft the editor
 * hands over. Requests never wait on the network — they wait on the worker's
 * own sync, which the caller starts (and restarts after a push). */
export class SourceIntel {
  #generation = 0;
  #pending = new Map<number, IntelPending>();
  #seq = 0;
  /** Last text handed to the worker: a request can bring the worker's copy up
   * to date with one small message instead of shipping the file every call. */
  #sent = new Map<string, string>();
  #started: Promise<void> | undefined;
  #worker: Worker | undefined;

  /** Build the worker's program from `load`'s payload plus the current drafts.
   * Memoized: concurrent callers share one sync (a second call while the first
   * bundle is still in flight is the common case — the page opens several
   * files, or a stale open competes with a fresh one). */
  sync(
    load: () => Promise<IntelSources>,
    drafts: readonly IntelFile[]
  ): Promise<void> {
    this.#started ??= this.#start(load, drafts);
    return this.#started;
  }

  /** Re-sync from scratch (a push changed the repo): the replies still in
   * flight answer a program that no longer exists, so they are dropped. */
  reset(
    load: () => Promise<IntelSources>,
    drafts: readonly IntelFile[]
  ): Promise<void> {
    this.#generation += 1;
    this.#failPending(new Error("source intelligence reset"));
    this.#sent.clear();
    this.#started = this.#start(load, drafts);
    return this.#started;
  }

  /** Stop the worker and reject whatever is in flight. */
  dispose(): void {
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
    load: () => Promise<IntelSources>,
    drafts: readonly IntelFile[]
  ): Promise<void> {
    const worker = this.#worker ?? this.#createWorker();
    let sources: IntelSources;
    try {
      sources = await load();
    } catch {
      // The bundle/declaration fetch is the one step that fails for reasons the
      // editor cannot fix (auth, network). Forget the attempt so the next file
      // the user opens retries; until then every request answers null.
      this.#started = undefined;
      return;
    }
    this.#sent = new Map(drafts.map((draft) => [draft.path, draft.text]));
    try {
      await this.#post(worker, {
        bundle: sources.bundle,
        drafts: [...drafts],
        id: this.#nextId(),
        kind: "sync",
        types: sources.types,
      });
    } catch {
      // The worker died installing the snapshot (only reachable through its
      // own failure): same recovery as a failed load.
      this.#started = undefined;
    }
  }

  #createWorker(): Worker {
    const worker = createIntelWorker();
    worker.addEventListener("message", (event: MessageEvent<IntelReply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(reply.id);
      if (reply.ok) {
        pending.resolve(reply.value);
      } else {
        pending.reject(new Error(reply.error));
      }
    });
    worker.addEventListener("error", (event) => {
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
