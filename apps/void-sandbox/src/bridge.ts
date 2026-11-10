/**
 * Stream bridges: the one-shot close that decrements the activity count when
 * a piped stream ends, and the terminal state of a writable pipe.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Open
 *   Open --> Closing: close(reason)
 *   Closing --> Closed: finish settled
 *   Closed --> Closed: close (idempotent)
 * ```
 *
 * Before, "has the finish already run?" lived in a `finished` boolean inside
 * a closure, and a stream that ended twice (or a body cancelled after `done`)
 * could double-count. `close` is the only transition, so the count moves at
 * most once per stream and the reason is recorded.
 */

export type BridgeCloseReason = "cancel" | "done" | "error";

export type BridgeState =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Closing" }
  | { readonly _tag: "Closed"; readonly reason: BridgeCloseReason };

/** A single-use close latch: `finish` runs at most once, however it is reached. */
export class StreamBridge {
  #state: BridgeState = { _tag: "Open" };
  #settled: Promise<void> | undefined;
  readonly #finish: () => Promise<void>;

  constructor(finish: () => Promise<void>) {
    this.#finish = finish;
  }

  get state(): BridgeState {
    return this.#state;
  }

  /** Idempotent: a second close joins the first and never re-runs `finish`. */
  close(reason: BridgeCloseReason): Promise<void> {
    if (this.#state._tag !== "Open") {
      return this.#settled ?? Promise.resolve();
    }

    this.#state = { _tag: "Closing" };

    this.#settled = (async () => {
      try {
        await this.#finish();
      } finally {
        this.#state = { _tag: "Closed", reason };
      }
    })();

    return this.#settled;
  }
}

/** Terminal state of a writable pipe (`stdin`): `close`/`abort` close it once. */
export type WriteState =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Closed" };

/** The only transition of the writable pipe. */
export const closeWrite = (state: WriteState): WriteState =>
  state._tag === "Open" ? { _tag: "Closed" } : state;
