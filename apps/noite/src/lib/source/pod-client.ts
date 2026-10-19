//! The control page's side of the pod frame: the handshake that opens it, the
//! `MessageChannel` it is bound with, and the RPC that runs over that port.
//!
//! The frame is a document on the app's pod host (`POD_HOST_HTML_PATH`),
//! and the *whole* pod — Nodepod, its workers, the shell — lives in it. Nothing
//! app-controlled therefore runs in this page's agent cluster, and nothing here
//! touches the pod except through the protocol in `./pod-protocol`.
//!
//! The handshake is the only place an origin is checked: the frame is opened
//! with `allow="cross-origin-isolated"` (a permissions-policy feature whose
//! default allowlist is `self`), this page posts `hello` carrying a nonce it
//! minted, and only a `ready` that echoes that nonce — from the pod host origin
//! and the frame's own window, and carrying a cross-origin-isolated agent
//! cluster — gets `port2` transferred to it. The nonce is the capability:
//! another document on the pod host origin (the pod's own servers, which *are*
//! same-origin with the frame) can post to the frame's window but cannot know
//! the nonce, so it can never bind the port. Everything after that is inside
//! the port, which no other document can reach.
//!
//! A frame that never answers is loaded again every `HANDSHAKE_RETRY_MS` (a
//! refused response leaves an error page that will never answer) until the
//! `HANDSHAKE_TIMEOUT_MS` deadline — a new app's pod host only starts
//! answering once the edge has picked the app up.

import { NO_POD_HOST_MESSAGE, POD_HOST_HTML_PATH } from "../preview-host";
import { POD_PROTOCOL_VERSION } from "./pod-protocol";
import type {
  PodAskMap,
  PodAskMessage,
  PodConnect,
  PodEventMap,
  PodHello,
  PodReady,
  PodRequestMap,
} from "./pod-protocol";

/** How long the frame has to load and answer its handshake, in total. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** How often a frame that has not answered is loaded again. */
const HANDSHAKE_RETRY_MS = 2000;

/** How long an ordinary request may wait for its answer. The few requests
 * whose work is minutes long (`open`) pass
 * `0`: their progress arrives as events, and a deadline over an install would
 * fail work that is going fine. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long a call may wait; `0` waits for as long as the frame lives. */
export interface CallOptions {
  timeout?: number;
}

/** A pending timer, however this environment names it: a browser number, a
 * Bun handle. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** The frame's answer to a reverse ask — the value, plus what crosses with it
 * rather than being copied. */
export interface PodAskAnswer {
  transfer?: Transferable[];
  value: AskedValue;
}

/** What this page does with a reverse ask: its own call (a cookie-carrying
 * fetch), never the frame's. Throwing refuses the ask, which reaches the
 * frame's own request as a failure. */
export type PodAskHandler = (ask: PodAskMessage) => Promise<PodAskAnswer>;

/** The frame, as this page drives it: requests in, events out. Every kind and
 * payload is the protocol's own (see `./pod-protocol`), so a caller cannot
 * invent one. */
export interface PodConnection {
  /** Ask the frame something. Rejects when the frame answers with a failure,
   * when the request's deadline passes, or once the frame is gone. */
  call: <K extends keyof PodRequestMap>(
    kind: K,
    params: PodRequestMap[K]["p"],
    options?: CallOptions
  ) => Promise<PodRequestMap[K]["r"]>;
  /** Listen for one kind of frame event; the returned function stops it. */
  on: <K extends keyof PodEventMap>(
    kind: K,
    listener: (payload: PodEventMap[K]) => void
  ) => () => void;
  /** Tear the transport down: the frame's document goes, and every request
   * still waiting fails. The frame's own teardown is a `close` request, sent
   * while this still holds. */
  close: () => Promise<void>;
}

export interface PodFrameOptions {
  appId: string;
  /** The ref the frame's pod checks out; the frame refuses an `open` that
   * names another. */
  branch: string;
  /** How the frame's `archive` ask is answered (see `PodAskHandler`). */
  onAsk: PodAskHandler;
  /** The unrecoverable failure the frame reported; the page says so. */
  onFatal?: (message: string) => void;
  /** The app's pod host origin — the one origin the frame may live on. */
  previewOrigin: string;
}

/** One bound port, and how to let go of the frame it belongs to. */
export interface PodPortOptions {
  /** The frame's document and the handshake listener, torn down with the
   * port: a dead port leaves no reason to keep either. */
  dispose: () => void;
  onAsk: PodAskHandler;
  onFatal?: (message: string) => void;
  port: MessagePort;
}

/** What one protocol message carries — an answer's value, an event's payload.
 * Every result the protocol defines is one of these, and whatever it holds is
 * the receiving side's own kind to read (see `PodRequestMap`/`PodEventMap`). */
type Carried = boolean | number | object | string | null | undefined;

/** What a request answers with, once the frame's own server has typed it:
 * every result the protocol defines. */
type AnsweredValue = PodRequestMap[keyof PodRequestMap]["r"];

/** What an ask answers with — the one shape `PodAskMap` defines. */
type AskedValue = PodAskMap[keyof PodAskMap]["r"];

/** One event's payload: every payload the protocol defines, before the
 * listener for its kind reads it. */
type EventPayload = PodEventMap[keyof PodEventMap];

/** One event listener, as this side stores it. */
type DispatchListener = (payload: EventPayload) => void;

/** One message off the port, split into the shapes there are: an answer (an id
 * this page minted), an event (a kind), or a reverse ask (`ask`). */
type PortMessage =
  | { i: number; kind: "answer"; ok: false; failure: string }
  | { i: number; kind: "answer"; ok: true; value: AnsweredValue }
  | { i: number; kind: "ask"; message: PodAskMessage }
  | { ev: string; kind: "event"; payload: EventPayload; text: string };

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the port is this page's I/O boundary: a message is read field by field here, and nothing off it is used before it has been checked. */
/** The frame's `ready`, or null for anything that is not one. */
const podReady = (value: unknown): PodReady | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const fields = new Map<string, Carried>(Object.entries(value));
  const nonce = fields.get("nonce");
  const t = fields.get("t");
  const v = fields.get("v");

  if (
    typeof nonce !== "string" ||
    typeof t !== "string" ||
    typeof v !== "number"
  ) {
    return null;
  }

  return {
    isolated: fields.get("isolated") === true,
    nonce,
    sharedArrayBuffer: fields.get("sharedArrayBuffer") === true,
    t: "ready",
    v,
  };
};

/** One field of an untrusted message, if it is a string. */
const stringField = (
  fields: Map<string, Carried>,
  name: string
): string | null => {
  const value = fields.get(name);

  return typeof value === "string" ? value : null;
};

/** One field of an untrusted message, if it is an object. */
const objectField = (
  fields: Map<string, Carried>,
  name: string
): Map<string, Carried> | null => {
  const value = fields.get(name);

  if (typeof value !== "object" || value === null) {
    return null;
  }

  return new Map<string, Carried>(Object.entries(value));
};

/** The `e: {message}` one failure carries. */
const failureField = (fields: Map<string, Carried>): string | null => {
  const error = objectField(fields, "e");
  const message = error === null ? null : error.get("message");

  return typeof message === "string" ? message : null;
};

/** A message off the port, or null for anything that is not the protocol's
 * own shape (it is then not acted on). */
const portMessage = (value: unknown): PortMessage | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const fields = new Map<string, Carried>(Object.entries(value));
  const i = fields.get("i");

  if (typeof i === "number") {
    const ok = fields.get("ok");

    if (ok === true) {
      // SAFETY: a frame's own server typed this value against the same request
      // map this page minted the id from, which is the only thing that could
      // have answered that id.
      return {
        i,
        kind: "answer",
        ok: true,
        value: fields.get("v") as AnsweredValue,
      };
    }

    if (ok === false) {
      return {
        failure: failureField(fields) ?? "the pod frame failed",
        i,
        kind: "answer",
        ok: false,
      };
    }

    // `archive` is the protocol's only ask, so an id with that kind is the
    // only one worth reading.
    const ask = stringField(fields, "ask");
    const params = objectField(fields, "p");
    const sha = params === null ? null : stringField(params, "sha");

    if (ask === "archive" && sha !== null) {
      return { i, kind: "ask", message: { ask, i, p: { sha } } };
    }

    return null;
  }

  const ev = stringField(fields, "ev");
  const payload = fields.get("p");

  if (ev !== null && typeof payload === "object" && payload !== null) {
    // SAFETY: every event the protocol defines carries an object payload, and
    // the listener for `ev` is the one that says which of them this is.
    return {
      ev,
      kind: "event",
      payload: payload as EventPayload,
      text:
        stringField(
          new Map<string, Carried>(Object.entries(payload)),
          "message"
        ) ?? "",
    };
  }

  return null;
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** One request waiting for its answer. */
interface PendingCall {
  reject: (error: Error) => void;
  resolve: (value: AnsweredValue) => void;
  /** The request's deadline, absent when it has none. */
  timer?: TimerHandle;
}

/** The page's handle on one frame, over a port it was handed: requests out
 * with ids, events in, reverse asks answered. `openPodFrame` builds one after
 * the handshake; a test builds one over its own `MessageChannel` pair, which
 * is what lets the RPC be exercised without a frame document. */
export const bindPodPort = (options: PodPortOptions): PodConnection => {
  const { dispose, onAsk, onFatal, port } = options;
  const pending = new Map<number, PendingCall>();
  const listeners = new Map<string, Set<DispatchListener>>();
  let nextId = 1;
  let closed = false;

  /** Every request in flight fails with `message`, and the connection is done:
   * there is no half-dead state where a caller waits forever. */
  const stop = (message: string): void => {
    closed = true;
    port.close();

    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(message));
    }

    pending.clear();
  };

  const answerAsk = async (ask: PodAskMessage): Promise<void> => {
    const { i } = ask;

    try {
      const answer = await onAsk(ask);
      port.postMessage(
        { answer: i, ok: true, v: answer.value },
        answer.transfer ?? []
      );
    } catch (error) {
      port.postMessage({
        answer: i,
        e: {
          message:
            error instanceof Error ? error.message : "the control refused",
        },
        ok: false,
      });
    }
  };

  /** What the frame sent, once it has been classified. */
  const receive = (message: PortMessage): void => {
    if (message.kind === "ask") {
      void answerAsk(message.message);

      return;
    }

    if (message.kind === "answer") {
      const call = pending.get(message.i);

      if (call === undefined) {
        return;
      }

      pending.delete(message.i);
      clearTimeout(call.timer);

      if (message.ok) {
        call.resolve(message.value);
      } else {
        call.reject(new Error(message.failure));
      }

      return;
    }

    const { ev, payload, text } = message;

    // The unrecoverable one: the frame's pod is gone, so every request in
    // flight fails with the same words, the page says why, and the frame's
    // document goes.
    if (ev === "fatal") {
      const reason = text === "" ? "the workspace stopped unexpectedly" : text;
      onFatal?.(reason);
      stop(reason);
      dispose();

      return;
    }

    for (const listener of listeners.get(ev) ?? []) {
      listener(payload);
    }
  };

  port.addEventListener("message", (event: MessageEvent) => {
    const message = portMessage(event.data);

    if (message !== null) {
      receive(message);
    }
  });
  // A port that only ever had a listener added delivers nothing until it is
  // started: `onmessage` starts it as a side effect, `addEventListener` does
  // not. Without this the page sends requests into a port that answers into
  // nowhere to be heard — every answer, event and ask is queued and never
  // dispatched.
  port.start();

  const call = <K extends keyof PodRequestMap>(
    kind: K,
    params: PodRequestMap[K]["p"],
    callOptions?: CallOptions
  ): Promise<PodRequestMap[K]["r"]> => {
    const answeredCall = Promise.withResolvers<PodRequestMap[K]["r"]>();

    if (closed) {
      answeredCall.reject(new Error("the pod frame is closed"));

      return answeredCall.promise;
    }

    const id = nextId;
    nextId += 1;
    const timeout = callOptions?.timeout ?? REQUEST_TIMEOUT_MS;

    const timer =
      timeout === 0
        ? undefined
        : setTimeout(() => {
            pending.delete(id);
            answeredCall.reject(
              new Error(
                `${String(kind)}: the pod frame did not answer within ${timeout / 1000}s`
              )
            );
          }, timeout);

    pending.set(id, {
      reject: answeredCall.reject,
      resolve: (value) => {
        // SAFETY: the answer was matched to the id this call minted, and the
        // frame's own server typed that answer against this same map.
        answeredCall.resolve(value as PodRequestMap[K]["r"]);
      },
      timer,
    });
    port.postMessage({ i: id, k: kind, p: params });

    return answeredCall.promise;
  };

  /** Register one listener under the kind it takes; the returned function
   * stops it. The payload it is handed is the one routed under that kind,
   * which is what its own signature types it as. */
  const onEvent = <K extends keyof PodEventMap>(
    kind: K,
    listener: (payload: PodEventMap[K]) => void
  ): (() => void) => {
    const name = String(kind);
    const attached = listeners.get(name) ?? new Set<DispatchListener>();

    const stored: DispatchListener = (payload) => {
      // SAFETY: this listener was registered for `name`, and `receive` routes
      // a payload by its own `ev` alone, so the payload is `listener`'s kind.
      listener(payload as PodEventMap[K]);
    };

    attached.add(stored);
    listeners.set(name, attached);

    return () => {
      attached.delete(stored);
    };
  };

  return {
    call,
    close: () => {
      stop("the pod frame was closed");
      dispose();

      return Promise.resolve();
    },
    on: onEvent,
  };
};

/** Open the pod frame `previewOrigin` and bind a port to it. Resolves once the
 * frame has answered the handshake, proven cross-origin isolated, and taken
 * the port; rejects (and removes the frame) for anything less — never a silent
 * fallback that would run the pod's code in this page's agent cluster. */
export const openPodFrame = async (
  options: PodFrameOptions
): Promise<PodConnection> => {
  const { appId, branch, onAsk, onFatal, previewOrigin } = options;

  if (previewOrigin === "") {
    throw new Error(NO_POD_HOST_MESSAGE);
  }

  const nonce = crypto.randomUUID();
  const frame = document.createElement("iframe");
  // Hidden, not sandboxed: a sandboxed frame has an opaque origin, and this
  // frame's origin — the app's pod host, never this page's — is the whole
  // point. `cross-origin-isolated` is the permissions-policy its agent cluster
  // needs for `SharedArrayBuffer`: without it neither the frame nor its
  // workers get one, whatever headers the response carries.
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("allow", "cross-origin-isolated");
  frame.title = "Workspace";

  const query = new URLSearchParams({
    appId,
    branch,
    nonce,
    parentOrigin: window.location.origin,
  });

  const frameUrl = `${previewOrigin}${POD_HOST_HTML_PATH}?${query}`;
  frame.src = frameUrl;
  const answered = Promise.withResolvers<PodReady>();
  const frameWindow = (): Window | null => frame.contentWindow;

  const say = (
    message: PodConnect | PodHello,
    transfer: Transferable[] = []
  ): void => {
    frameWindow()?.postMessage(message, previewOrigin, transfer);
  };

  const hello = (): void => {
    say({ nonce, t: "hello", v: POD_PROTOCOL_VERSION });
  };

  const onWindowMessage = (event: MessageEvent): void => {
    // Both the origin and the source window are checked: another document on
    // the pod host origin may post to the frame, but only the frame's own
    // window can post to this page as the frame.
    if (event.origin !== previewOrigin || event.source !== frameWindow()) {
      return;
    }

    const reply = podReady(event.data);

    if (
      reply === null ||
      reply.v !== POD_PROTOCOL_VERSION ||
      reply.nonce !== nonce
    ) {
      return;
    }

    answered.resolve(reply);
  };

  window.addEventListener("message", onWindowMessage);
  let retry: TimerHandle | undefined;

  const onFrameLoad = (): void => {
    // The first `hello` that can land: until the frame's document commits, its
    // window is still the initial `about:blank`, which inherits *this* page's
    // origin and drops a message targeted at the pod host origin. The frame
    // also answers its handshake unsolicited, so this is a second ask —
    // repeated on every load, including the retry's own reload.
    hello();
    clearTimeout(retry);
    retry = setTimeout(() => {
      frame.src = frameUrl;
    }, HANDSHAKE_RETRY_MS);
  };

  frame.addEventListener("load", onFrameLoad);
  document.body.append(frame);

  const deadline = setTimeout(() => {
    answered.reject(
      new Error(
        `Could not start the workspace: the pod host at ${previewOrigin} did not answer. Reload the page to try again.`
      )
    );
  }, HANDSHAKE_TIMEOUT_MS);

  let replied: PodReady;

  try {
    replied = await answered.promise;
  } catch (error) {
    window.removeEventListener("message", onWindowMessage);
    frame.remove();
    throw error;
  } finally {
    clearTimeout(retry);
    clearTimeout(deadline);
    frame.removeEventListener("load", onFrameLoad);
  }

  // Fail closed: without a cross-origin-isolated agent cluster on the frame's
  // origin its workers get no `SharedArrayBuffer`, which would cost the pod
  // `execSync`, its shared filesystem and the threaded WASM toolchains. A pod
  // that quietly runs half of what it promises is worse than one that says why
  // it cannot run.
  if (!(replied.isolated && replied.sharedArrayBuffer)) {
    window.removeEventListener("message", onWindowMessage);
    frame.remove();
    throw new Error(
      `Pod host ${previewOrigin} is not cross-origin isolated, so the workspace cannot run with SharedArrayBuffer`
    );
  }

  const channel = new MessageChannel();
  say({ nonce, port: channel.port2, t: "connect", v: POD_PROTOCOL_VERSION }, [
    channel.port2,
  ]);

  return bindPodPort({
    dispose: () => {
      window.removeEventListener("message", onWindowMessage);
      frame.remove();
    },
    onAsk,
    onFatal,
    port: channel.port1,
  });
};
