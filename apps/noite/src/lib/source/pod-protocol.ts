//! The wire contract between the control UI and the pod frame: the types of
//! every message that crosses between this page and the document that holds
//! the pod, on the app's preview origin. Both bundles compile this file, so it
//! imports nothing that runs — only the vocabulary the two sides already
//! share — and it is frozen before either side is written.
//!
//! Why a protocol at all: the pod is the workspace's whole filesystem, the
//! place every command runs and the origin of every preview URL, so it belongs
//! to the app's preview origin and never to the control UI's own. A worker
//! takes the origin of the document that creates it, and Nodepod shares one
//! `MemoryVolume` with its workers through a `SharedArrayBuffer` — which an
//! agent cluster is keyed by origin for, so nothing about the pod can be built
//! on the control page and moved. The whole pod lives in the frame
//! (`src/pod-host/main.ts`); this page drives it over a `MessageChannel`.
//!
//! # Transport
//!
//! 1. The page frames
//!    `<previewOrigin>/noite-pod-host.html?parentOrigin=<this origin>&appId=&branch=&nonce=`
//!    with `allow="cross-origin-isolated"`, then posts `PodHello` (the nonce
//!    it minted) to the frame's window, targeted at the preview origin.
//! 2. The frame accepts a `hello` only from `parentOrigin` (both window and
//!    script are the parent's, so it checks `event.source === window.parent`)
//!    with the nonce it read from its own URL, answers `PodReady`, and refuses
//!    to serve anything without `crossOriginIsolated` — a pod without
//!    `SharedArrayBuffer` is not a pod.
//! 3. The page checks the answer's origin and source window, then sends
//!    `PodConnect` with `port2` transferred. From then on, everything is on
//!    that port.
//!
//! The nonce is the capability: a document that shares the preview origin (the
//! app's own preview, which *is* same-origin with the frame) can post to the
//! frame's window, but it cannot know a nonce minted after the frame was
//! opened and never written anywhere the frame's origin can read. Nothing else
//! about the frame is a secret — the app owns the origin.
//!
//! # Shape
//!
//! Requests (page → frame) are `{i, k, p}` — an id, a kind, the kind's params —
//! and are answered `{i, ok: true, v}` or `{i, ok: false, e: {code?, message}}`.
//! Events (frame → page) are `{ev, p}`, with no id. Reverse asks (frame → page)
//! are `{ask, i, p}` and are answered `{answer: i, ok, v|e}`; they share the id
//! space with the requests. Every message is parsed as untrusted input by the
//! side that receives it: check the fields you read, ignore anything else.
//!
//! # What the frame may not do
//!
//! `archive` is the frame's *only* ask. There is no reverse `commit`: the frame
//! builds a push payload (`push.prepare`) and this page commits it from the
//! user's Push click, with its own session cookies (`push.settle` says how that
//! went). The app's preview document shares the frame's origin and can reach
//! the frame's globals, so a frame able to ask for a commit would be an app
//! able to commit through the viewer's session. Likewise the `archive` answer
//! is only ever sent while an `open` request is in flight, so a compromised
//! frame cannot use this page as a general fetch proxy.

import type { TreeEntry } from "../runner";
import type {
  PreviewLogStream,
  PreviewPlan,
  PreviewState,
} from "./preview/types";
import type {
  CheckoutListing,
  PushPayload,
  WorkspaceChange,
  WorkspacePush,
  WorkspaceStat,
} from "./workspace/types";

/** The vocabulary the wire carries, re-exported so both bundles read the
 * protocol's own messages and the values inside them from this one file. */
export type {
  CheckoutListing,
  PushPayload,
  WorkspaceChange,
  WorkspacePush,
  WorkspaceStat,
} from "./workspace/types";
export type {
  PreviewLogStream,
  PreviewPlan,
  PreviewState,
} from "./preview/types";

/** The protocol revision both ends speak. A `hello`/`ready` whose `v` is not
 * this one is refused rather than guessed at. */
export const POD_PROTOCOL_VERSION = 1;

/** One page → frame request's params and result, by kind. A kind's params
 * object keeps its own field names, so the call sites read like the facade
 * they replace; a kind that answers nothing has `r: undefined` (a `void` result
 * would be a function's, and these are values on the wire). */
export interface PodRequestMap {
  /** Boot or restore the pod for one ref. The archive ask and the initial
   * derive happen inside this request. */
  open: { p: PodOpenParams; r: PodOpenResult };
  /** The checkout's rows as the tree renders them. */
  listing: { p: undefined; r: CheckoutListing };
  /** The Changes panel's rows, as of the last derive. */
  changes: { p: undefined; r: WorkspaceChange[] };
  /** The commit's text at a path, from the pod's own blob cache. */
  baseText: { p: { path: string }; r: string | null };
  mkdir: { p: { path: string }; r: undefined };
  writeText: { p: { path: string; text: string }; r: undefined };
  writeBytes: { p: { bytes: Uint8Array; path: string }; r: undefined };
  remove: { p: { path: string }; r: undefined };
  rename: { p: { from: string; to: string }; r: undefined };
  restore: { p: { path: string }; r: undefined };
  discard: { p: { path: string }; r: undefined };
  discardAll: { p: undefined; r: undefined };
  /** Derive now and answer when the rows are out. */
  refresh: { p: undefined; r: undefined };
  /** Land whatever the pod still owes its saved copy. */
  flush: { p: undefined; r: undefined };
  /** Tear the pod down; the page removes the frame after this answers. */
  close: { p: undefined; r: undefined };
  "fs.read": { p: { path: string }; r: Uint8Array };
  "fs.stat": { p: { path: string }; r: WorkspaceStat };
  "fs.exists": { p: { path: string }; r: boolean };
  "fs.readdir": { p: { path: string }; r: string[] };
  "fs.write": { p: { data: string | Uint8Array; path: string }; r: undefined };
  "fs.mkdir": {
    p: { path: string; recursive?: boolean };
    r: undefined;
  };
  "fs.rm": {
    p: { force?: boolean; path: string; recursive?: boolean };
    r: undefined;
  };
  "fs.rename": { p: { from: string; to: string }; r: undefined };
  /** Start following a path in the pod; the frame answers the id the events
   * carry. Closing the page's handle is an `fs.unwatch`. */
  "fs.watch": {
    p: { path: string; recursive?: boolean };
    r: { watchId: number };
  };
  "fs.unwatch": { p: { watchId: number }; r: undefined };
  /** Build the payload the page will commit, and hold the push open until
   * `push.settle`. Resolves with a JSON-safe payload (≤40 MiB), which the page
   * POSTs to the commit route itself. */
  "push.prepare": { p: WorkspacePush; r: { payload: PushPayload } };
  /** How the page's commit went: `sha` settles the pod on the commit, and a
   * failure leaves it exactly as it was (the Push panel shows the error). */
  "push.settle": { p: PushSettleParams; r: undefined };
  "preview.open": { p: undefined; r: PodPreviewView };
  "preview.close": { p: undefined; r: PodPreviewView };
  "preview.restart": { p: undefined; r: PodPreviewView };
  "preview.stop": { p: undefined; r: PodPreviewView };
  "preview.view": { p: undefined; r: PodPreviewView };
  "terminal.open": {
    p: { cols: number; rows: number };
    r: { sessionId: number };
  };
  "terminal.input": { p: { data: string }; r: undefined };
  "terminal.resize": { p: { cols: number; rows: number }; r: undefined };
  "terminal.close": { p: undefined; r: undefined };
}

export type PodRequestKind = keyof PodRequestMap;

/** One frame → page event's payload, by kind. */
export interface PodEventMap {
  /** The rows after a derive, with the commit they were derived against. */
  changes: PodChangesEvent;
  /** A path under a watch was touched. */
  "fs.event": PodFsEvent;
  /** Another tab's edits landed in this pod (see `tab-sync.ts`); `structural`
   * when a path came, went or moved, which the tree's rows have to follow. */
  peer: { structural: boolean };
  /** The pod's saved copy could not be written: what the page shows is not
   * being kept (the pod keeps retrying on its own). */
  saveError: { message: string };
  /** Everything the shell writes: the prompt, the echo, output, the preview's
   * foreground job. Batched by the frame, flushed once per frame by the page. */
  "terminal.write": { data: string };
  "preview.state": PodPreviewStateEvent;
  "preview.log": { stream: PreviewLogStream; text: string };
  /** An error the frame cannot recover from: the page shows it and tears the
   * workspace down. */
  fatal: { message: string };
}

export type PodEventKind = keyof PodEventMap;

/** One frame → page ask's params and answer, by kind. The only reverse ask:
 * the frame can read one ref's archive, through the page's own session, while
 * that ref is opening. */
export interface PodAskMap {
  archive: { p: { sha: string }; r: { bytes: ArrayBuffer } };
}

export type PodAskKind = keyof PodAskMap;

/** What the page tells the frame about the ref it is opening. The frame binds
 * the port to the `appId`/`branch` of its own URL and refuses an `open` that
 * disagrees, so a port that crossed origins by accident cannot open another
 * app's workspace. */
export interface PodOpenParams {
  appId: string;
  branch: string;
  /** Whether the ref may be edited: a read-only ref persists nothing and
   * refuses every mutation. */
  editable: boolean;
  /** The ref's listing (`source.tree`): what a fresh checkout stamps as its
   * base. */
  files: TreeEntry[];
  /** The resolved commit of the browsed ref, which is what the archive ask
   * reads and what `stale` compares against. */
  sha: string;
}

/** What `open` answers: the state the page cannot derive from the events that
 * follow it (the rows and the base arrive as a `changes` event). */
export interface PodOpenResult {
  /** The commit the pod is based on; never null — the open always lands one. */
  baseSha: string;
  /** `editable` can only narrow: a ref the user may not edit is read-only even
   * where the pod could write. */
  editable: boolean;
  /** The browsed tip, when the pod holds unpushed work against another
   * commit. */
  stale: string | null;
}

/** How the page's own commit went. */
export interface PushSettleParams {
  /** The error the commit route reported, for the log the page keeps. */
  error?: string;
  ok: boolean;
  /** The commit the push landed, when it did. */
  sha?: string;
  target: string;
}

/** The rows after a derive. */
export interface PodChangesEvent {
  /** The commit those rows were derived against: a push settles the pod, and
   * `revertToBase` moves it, without the page asking. */
  baseSha: string;
  changes: WorkspaceChange[];
  /** Monotonic, bumped whenever a derive publishes: a page that has to drop a
   * stale event can order them. */
  revision: number;
}

/** One filesystem event under a watch the page opened. */
export interface PodFsEvent {
  event: string;
  filename: string | null;
  watchId: number;
}

/** The preview's state without its log: what the panel draws above the log,
 * and what a `preview.state` event carries. */
export interface PodPreviewStateEvent {
  /** What the preview is doing — the detail `onState` last reported. */
  detail: string;
  /** The failure verbatim: a start that threw, or a restart that did. */
  error: string;
  plan: PreviewPlan | null;
  /** The preview's live child processes, oldest first — what the terminal's
   * `preview` command reads. */
  processes: string[];
  state: PreviewState | "idle";
  /** The running preview's URL: what the panel's iframe loads. */
  url: string;
}

/** The whole view, log included: what the page's `preview.view` (and every
 * other preview request) answers with, so a panel that mounts late draws the
 * same thing as one that watched. */
export interface PodPreviewView extends PodPreviewStateEvent {
  logs: PodPreviewLog[];
}

/** One line the preview printed. */
export interface PodPreviewLog {
  stream: PreviewLogStream;
  text: string;
}

/** One request: an id the answer reuses, its kind, and the kind's params. */
export interface PodRequest<K extends PodRequestKind = PodRequestKind> {
  i: number;
  k: K;
  p: PodRequestMap[K]["p"];
}

/** A request that answered. */
export interface PodOkResponse<K extends PodRequestKind = PodRequestKind> {
  i: number;
  ok: true;
  v: PodRequestMap[K]["r"];
}

/** What went wrong, whether the frame refused or the work threw. */
export interface PodError {
  code?: string;
  message: string;
}

/** A request that failed. */
export interface PodFailResponse {
  e: PodError;
  i: number;
  ok: false;
}

export type PodResponse<K extends PodRequestKind = PodRequestKind> =
  | PodOkResponse<K>
  | PodFailResponse;

/** One event: its kind and payload, no id. */
export interface PodEvent<K extends PodEventKind = PodEventKind> {
  ev: K;
  p: PodEventMap[K];
}

/** One reverse ask: the kind, an id its answer reuses, and the kind's params. */
export interface PodAskMessage<K extends PodAskKind = PodAskKind> {
  ask: K;
  i: number;
  p: PodAskMap[K]["p"];
}

/** A reverse ask that was answered. */
export interface PodAnsweredAsk<K extends PodAskKind = PodAskKind> {
  answer: number;
  ok: true;
  v: PodAskMap[K]["r"];
}

/** A reverse ask that was refused. */
export interface PodUnansweredAsk {
  answer: number;
  e: PodError;
  ok: false;
}

export type PodAnswer<K extends PodAskKind = PodAskKind> =
  | PodAnsweredAsk<K>
  | PodUnansweredAsk;

/** The page's first message, before any port exists: which handshake this is
 * (the nonce the page minted) and which revision. */
export interface PodHello {
  nonce: string;
  t: "hello";
  v: number;
}

/** The frame's answer: its nonce echoed back, and whether its own agent
 * cluster can share memory — the one thing that decides whether the pod can
 * run there at all. */
export interface PodReady {
  isolated: boolean;
  nonce: string;
  sharedArrayBuffer: boolean;
  t: "ready";
  v: number;
}

/** The page hands over the port the two sides then speak on. */
export interface PodConnect {
  nonce: string;
  port: MessagePort;
  t: "connect";
  v: number;
}

export type PodHandshake = PodConnect | PodHello | PodReady;
