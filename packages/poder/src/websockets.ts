/* eslint-disable max-classes-per-file -- socket and pair are one cohesive in-memory transport */
// In-memory WebSocketPair for Durable Objects. The client side starts open;
// the server side queues inbound messages until `accept()` (via
// `ctx.acceptWebSocket`), mirroring Cloudflare's accept semantics.
import { isString } from "./guards.ts";

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

type MessageData = string | ArrayBuffer | Uint8Array;

export class PoderWebSocket extends EventTarget {
  static readonly CONNECTING = WS_CONNECTING;
  static readonly OPEN = WS_OPEN;
  static readonly CLOSING = WS_CLOSING;
  static readonly CLOSED = WS_CLOSED;

  binaryType: "blob" | "arraybuffer" = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  readyState: number = WS_CONNECTING;
  private accepted = false;
  private peer: PoderWebSocket | null = null;
  private readonly queued: MessageData[] = [];

  /** Links the two halves of a pair (internal). */
  link(peer: PoderWebSocket, accepted: boolean): void {
    this.peer = peer;
    this.accepted = accepted;
    if (accepted) {
      this.readyState = WS_OPEN;
    }
  }

  accept(): void {
    if (this.readyState === WS_CLOSED) {
      throw new Error("WebSocket is closed");
    }
    this.accepted = true;
    this.readyState = WS_OPEN;
    const pending = this.queued.splice(0);
    queueMicrotask(() => {
      this.dispatch("open", new Event("open"));
      for (const data of pending) {
        this.deliver(data);
      }
    });
  }

  send(data: MessageData): void {
    if (
      this.readyState !== WS_OPEN &&
      !(this.readyState === WS_CONNECTING && this.accepted)
    ) {
      if (this.readyState === WS_CONNECTING) {
        this.queued.push(data);
        return;
      }
      throw new Error("WebSocket is not open");
    }
    const { peer } = this;
    if (peer === null) {
      throw new Error("WebSocket has no peer");
    }
    queueMicrotask(() => {
      peer.receive(data);
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WS_CLOSED) {
      return;
    }
    this.readyState = WS_CLOSING;
    const { peer } = this;
    queueMicrotask(() => {
      this.readyState = WS_CLOSED;
      this.dispatch(
        "close",
        new CloseEvent("close", { code, reason, wasClean: true })
      );
      if (peer !== null && peer.readyState !== WS_CLOSED) {
        peer.readyState = WS_CLOSED;
        peer.dispatch(
          "close",
          new CloseEvent("close", { code, reason, wasClean: true })
        );
      }
    });
  }

  /** Inbound delivery from the peer (internal). */
  receive(data: MessageData): void {
    if (this.readyState === WS_CLOSED) {
      return;
    }
    if (!this.accepted) {
      this.queued.push(data);
      return;
    }
    this.deliver(data);
  }

  private deliver(data: MessageData): void {
    if (isString(data)) {
      this.dispatch("message", new MessageEvent("message", { data }));
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // SAFETY: Uint8Array.from allocates an exact-size copy, so .buffer is that copy's ArrayBuffer.
    const buffer = Uint8Array.from(bytes).buffer as ArrayBuffer;
    this.dispatch("message", new MessageEvent("message", { data: buffer }));
  }

  private dispatch(type: string, event: Event): void {
    this.dispatchEvent(event);
    if (type === "open") {
      this.onopen?.(event);
    }
    if (type === "message") {
      // SAFETY: deliver() dispatches a MessageEvent exactly when type is "message".
      this.onmessage?.(event as MessageEvent);
    }
    if (type === "close") {
      // SAFETY: close() dispatches a CloseEvent exactly when type is "close".
      this.onclose?.(event as CloseEvent);
    }
  }
}

export class WebSocketPair {
  readonly 0: PoderWebSocket;
  readonly 1: PoderWebSocket;

  constructor() {
    const client = new PoderWebSocket();
    const server = new PoderWebSocket();
    client.link(server, true);
    server.link(client, false);
    this[0] = client;
    this[1] = server;
  }
}
