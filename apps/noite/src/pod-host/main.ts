//! The pod frame's entry: the document the control UI opens on the app's
//! preview origin, holding the whole pod.
//!
//! This file is the frame's front door and nothing else. It reads what the
//! frame was opened for off its own URL, answers the handshake of the one
//! window that may talk to it, hands the port it is given to the RPC server —
//! which owns the pod from then on — and stays out of the way.
//!
//! Why the pod lives here: Nodepod shares one `MemoryVolume` with its workers
//! through a `SharedArrayBuffer`, and an agent cluster is keyed by origin, so a
//! worker on another origin cannot receive it. A worker takes the origin of the
//! document that creates it, so this document — on the app's preview host,
//! which holds none of the control UI's authority — is the only place the
//! workspace's own code may execute. There is no fallback: a frame that is not
//! cross-origin isolated, or was not opened the way the control opens it, does
//! nothing at all rather than running the pod somewhere it must not.

import { POD_PROTOCOL_VERSION } from "../lib/source/pod-protocol";
import type { PodReady } from "../lib/source/pod-protocol";
import { planPreview } from "../lib/source/preview/plan";
import { startPreview } from "../lib/source/preview/start";
import { frameAddress, handshakeMessage } from "./handshake";
import type { PodAddress } from "./handshake";
import { createPodServer } from "./rpc-server";
import type { PodServer } from "./rpc-server";

/** Answer the handshake, and serve the pod once the port arrives. `address` is
 * the frame's own URL, checked before anything runs. */
const serve = (address: PodAddress): void => {
  const { appId, branch, nonce, parentOrigin } = address;
  let server: PodServer | null = null;
  /** The port is bound once. A second `connect` — the same page opening a
   * second channel, or a document on this origin trying its luck — is not. */
  let bound = false;

  const answerHandshake = (): void => {
    const ready: PodReady = {
      isolated: crossOriginIsolated === true,
      nonce,
      sharedArrayBuffer: globalThis.SharedArrayBuffer !== undefined,
      t: "ready",
      v: POD_PROTOCOL_VERSION,
    };
    window.parent.postMessage(ready, parentOrigin);
  };

  const onMessage = (event: MessageEvent): void => {
    // Both the origin and the source window: another document on this origin
    // may post here, but only the page named in this frame's own URL may be
    // answered as its parent.
    if (event.origin !== parentOrigin || event.source !== window.parent) {
      return;
    }
    const message = handshakeMessage(event.data);
    if (message === null || message.v !== POD_PROTOCOL_VERSION) {
      return;
    }
    if (message.nonce !== nonce) {
      return;
    }
    if (message.t === "hello") {
      answerHandshake();
      return;
    }
    if (bound) {
      return;
    }
    bound = true;
    window.removeEventListener("message", onMessage);
    server = createPodServer({
      appId,
      branch,
      origin: window.location.origin,
      plan: planPreview,
      port: message.port,
      start: startPreview,
    });
  };

  window.addEventListener("message", onMessage);
  window.addEventListener("pagehide", () => {
    // The frame is being removed (or navigated away): the pod's pending saves
    // get their one chance to land, since `close` may never have arrived.
    server?.flushPending();
  });
  // Unsolicited, and after the listener is attached: a page that posted its
  // `hello` before this module ran (a message with no listener is gone) gets
  // its answer all the same, and one that waits for this frame's load event
  // finds it already answered.
  answerHandshake();
};

const address = frameAddress(window.location.href, window.parent !== window);

if (address !== null) {
  serve(address);
}
