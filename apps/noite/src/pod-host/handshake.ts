//! Who a pod frame is talking to, and how it knows.
//!
//! Two things decide it, and both are checked here rather than in the entry:
//! the URL the frame was opened with (below), and the messages that arrive on
//! its window (`handshakeMessage`). Everything this module returns has been
//! checked field by field, because a window on this origin is not private —
//! the app's own preview document shares it.
//!
//! The control page builds the frame's URL (`?parentOrigin=&appId=&branch=&
//! nonce=`), and this is the frame's only source for all four: the page's
//! origin it will answer, the ref whose pod it serves, and the nonce that is
//! the handshake's capability. Nothing else about the frame is a secret — the
//! app's own preview document shares this origin and can reach this window —
//! so the URL's fields are the frame's whole identity, and a URL that does not
//! name all four is a document nobody opened on purpose: it serves nothing at
//! all rather than guessing.
//!
//! The page's origin is checked to be an *origin*, and to be an origin other
//! than this document's own. The control UI never shares the app's preview
//! host, and a document that framed itself would be answering a parent that is
//! this same origin — the shape a preview document would use to open a pod
//! frame of its own and speak to it as if it were the control.

import type { PodConnect, PodHello } from "../lib/source/pod-protocol";

/** What the frame was opened for. */
export interface PodAddress {
  appId: string;
  branch: string;
  /** The control page's origin: the only origin whose messages are read, and
   * the only one this document posts an answer to. */
  parentOrigin: string;
  /** The capability the page minted: a document on this origin can post to
   * this window, but cannot know the nonce. */
  nonce: string;
}

/** The address `url` names, or null when the document was not opened the way
 * the control opens it (see the module comment). `framed` is whether this
 * document is in a frame at all: the top-level document has no parent to
 * serve, and is never opened this way. */
export const frameAddress = (
  url: string,
  framed: boolean
): PodAddress | null => {
  if (!framed) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = parsed.searchParams;
  const appId = params.get("appId") ?? "";
  const branch = params.get("branch") ?? "";
  const nonce = params.get("nonce") ?? "";
  const parentOrigin = params.get("parentOrigin") ?? "";
  if (appId === "" || branch === "" || nonce === "" || parentOrigin === "") {
    return null;
  }
  let parent: URL;
  try {
    parent = new URL(parentOrigin);
  } catch {
    return null;
  }
  if (parent.origin !== parentOrigin || parent.origin === parsed.origin) {
    return null;
  }
  return { appId, branch, nonce, parentOrigin };
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a window message is I/O: every field is read here and checked before anything uses it. */
/** The handshake `value` is — the page's `hello`, or the `connect` that hands
 * over the port — or null for anything else (including a `ready`, which only
 * ever travels the other way). The caller has already checked the origin and
 * the source window; this checks the shape, so nothing off this window drives
 * the frame through a field it did not mean. */
export const handshakeMessage = (
  value: unknown
): PodConnect | PodHello | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fields = new Map(Object.entries(value));
  const t = fields.get("t");
  const v = fields.get("v");
  const nonce = fields.get("nonce");
  if (
    typeof t !== "string" ||
    typeof v !== "number" ||
    typeof nonce !== "string"
  ) {
    return null;
  }
  if (t === "hello") {
    return { nonce, t: "hello", v };
  }
  const port = fields.get("port");
  if (t === "connect" && port instanceof MessagePort) {
    return { nonce, port, t: "connect", v };
  }
  return null;
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
