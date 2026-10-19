//! The workspace layer's shared vocabulary: where the checkout and Noite's own
//! metadata live inside the pod, what `base.json` and the move journal hold,
//! and the row the Changes panel renders. Every other module in this directory
//! imports its shapes from here — and nothing here touches the pod, so the
//! whole file is safe to import from anywhere.

import type {
  Nodepod,
  NodepodFS,
  WorkspacePersistence,
} from "@r1ck404/nodepod";

import type { TreeEntry } from "../../runner";

/** The pod path the branch is checked out at — the only part of the pod the
 * source UI ever shows. */
export const PROJECT_ROOT = "/home/project";

/** Noite's own directory in the pod: the base index, the move journal and a
 * content-addressed copy of every committed blob. The app the pod runs never
 * sees it (it sits outside `PROJECT_ROOT`). */
export const META_ROOT = "/home/.noite";

/** The committed blobs, one file per git sha: what a discard restores from, so
 * neither a diff nor a discard ever goes back to the network. */
export const OBJECTS_DIR = `${META_ROOT}/objects`;

/** The index of the commit the checkout is based on. */
export const BASE_FILE = `${META_ROOT}/base.json`;

/** The move journal, `current path` → the committed path it came from. */
export const JOURNAL_FILE = `${META_ROOT}/moves.json`;

/** Leading slashes of a caller-supplied relative path. */
const LEADING_SLASHES = /^\/+/u;

/** The pod path `rel` names inside the checkout. `rel` is relative to
 * `PROJECT_ROOT` (what the tree, the editor and the Changes panel speak);
 * `""` is the checkout root itself. A `.` or `..` segment is refused: every
 * path the checkout, the tree or an upload hands in must stay inside the
 * checkout, never reach Noite's metadata beside it. */
export const projectPath = (rel: string): string => {
  const trimmed = rel.replace(LEADING_SLASHES, "");

  if (trimmed === "") {
    return PROJECT_ROOT;
  }

  if (
    trimmed.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`"${rel}" leaves the checkout`);
  }

  return `${PROJECT_ROOT}/${trimmed}`;
};

/** `abs` back in the tree's vocabulary. A path outside the checkout is
 * returned as it came (the workspace only ever hands back checkout paths). */
export const relPath = (abs: string): string => {
  const prefix = `${PROJECT_ROOT}/`;

  if (abs === PROJECT_ROOT) {
    return "";
  }

  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
};

/** The directory holding `abs` (the pod path of a file being written). */
export const parentDir = (abs: string): string => {
  const cut = abs.lastIndexOf("/");

  return cut <= 0 ? "/" : abs.slice(0, cut);
};

/** One committed file as the base index remembers it. */
export interface BaseEntry {
  mode: string;
  sha: string;
}

/** `base.json`: the commit the checkout is based on, and the blob every one of
 * its paths held. Keys are checkout-relative, sorted. */
export interface BaseIndex {
  baseSha: string;
  entries: Record<string, BaseEntry>;
}

/** `moves.json`: the rename journal — where a file sits now, and where the
 * commit it came from put it. */
export type Journal = Record<string, string>;

/** The blob modes git records, as the tree listing reports them. */
export type GitMode = "100644" | "100755" | "120000";

/** What a change does to its path. `moved` covers a rename the journal knows
 * about, whether or not the bytes changed on the way. */
export type ChangeKind = "added" | "deleted" | "modified" | "moved";

/** One row of the Changes panel: what the path holds now (`after`) and what
 * the commit holds at the same path or, for a move, at its origin (`before`).
 * A binary file carries its byte count instead of any text. */
export interface WorkspaceChange {
  after: string;
  before: string;
  /** Decoded byte count when the change is binary (no text to diff). */
  binary?: number;
  kind: ChangeKind;
  /** The committed side is still being read (the row is listed, not diffed). */
  loading?: boolean;
  /** For a move: the committed path the file came from. */
  movedFrom?: string;
  path: string;
}

/** The checkout as the tree renders it: every file, and every directory that
 * holds no file under it — git keeps no empty folder, so one only exists
 * because it was made here, and the tree is the only place it shows. Both
 * lists are checkout-relative and in path order.
 *
 * The `ignored*` lists are the paths the checkout's own `.gitignore` rules
 * exclude (folders without their slash): what git would not list at all, and
 * which the tree paints dimmed — the one place the user can still see it. No
 * row of the Changes panel and no push ever comes from them. */
export interface CheckoutListing {
  dirs: string[];
  files: string[];
  ignoredDirs: string[];
  ignoredFiles: string[];
}

/** The blob-id memo a derive keeps between runs: one entry per path, holding
 * the id it produced and the size+mtime key it was computed from, so a
 * rewritten file re-hashes and an untouched one never does. */
export type HashCache = Map<string, { key: string; sha: string }>;

/** The workspace's live state: the filesystem, the index of the commit it is
 * based on, the move journal, and the hash memo. A push or a discard replaces
 * parts of it, and the facade keeps the one object, so every module reads the
 * same truth while a derive, a push and a discard are all in flight. */
export interface WorkspaceState {
  base: BaseIndex;
  cache: HashCache;
  fs: WorkspaceFs;
  journal: Journal;
}

/** One stat of a checkout path — the slice of Nodepod's result the workspace
 * reasons about. */
export interface WorkspaceStat {
  isDirectory: boolean;
  isFile: boolean;
  mtime: number;
  size: number;
}

/** The slice of the pod's filesystem the source UI itself reads — the editor's
 * open, and the structural watch the tree follows. Everything else the UI does
 * to a path goes through the `Workspace` verbs, which the frame answers over
 * the RPC: a proxy has no business handing out a filesystem-wide surface. */
export interface SourceFs {
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<Uint8Array>;
  stat: (path: string) => Promise<WorkspaceStat>;
  /** Follow the pod's own filesystem events under `path`; `close` stops them.
   * The frame's watcher is the pod's, so an install or the
   * shell creating a file reaches the tree through here. */
  watch: (
    path: string,
    opts: { recursive?: boolean },
    notify: (event: string, filename: string | null) => void
  ) => { close: () => void };
}

/** The pod filesystem as this layer uses it. `NodepodFS` satisfies it, and so
 * does the in-memory adapter the tests drive, which is what keeps every module
 * but `pod.ts` free of the SDK. */
export interface WorkspaceFs {
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  /** The file as text — this overload first, so `readFile(path)` alone is the
   * bytes. */
  readFile: {
    (path: string, encoding: "utf-8"): Promise<string>;
    (path: string): Promise<Uint8Array>;
  };
  readdir: (path: string) => Promise<string[]>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (
    path: string,
    opts?: { force?: boolean; recursive?: boolean }
  ) => Promise<void>;
  stat: (path: string) => Promise<WorkspaceStat>;
  watch: (
    path: string,
    opts: { recursive?: boolean },
    notify: (event: string, filename: string | null) => void
  ) => { close: () => void };
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
}

/** Where a failed workspace save is reported: the pod retries it on its own,
 * but the page must say that what it shows is not being kept (a full browser
 * store, a denied quota, a partition that went away). */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a persistence failure is unknown by construction (a store may reject with anything); the page narrows it to text.
export type SaveErrorReporter = (error: unknown) => void;

/** What `openPod` takes: whose workspace, whether it may write, and where a
 * failed save is reported. The preview origin is not a parameter: this runs in
 * the pod frame, whose own origin is the app's pod host. */
export interface PodOptions {
  appId: string;
  branch: string;
  /** A ref the user can edit: only those persist to IndexedDB. */
  editable: boolean;
  onSaveError: SaveErrorReporter;
}

/** A booted pod plus the workspace's handle on it. Which tab saves is
 * invisible here: a tab that opened second edits the same way and takes over
 * saving when the saving tab goes (see `openPod` in `pod.ts`). */
export interface OpenPod {
  close: () => Promise<void>;
  editable: boolean;
  flush: () => Promise<void>;
  fs: NodepodFS;
  /** Called after another tab's edits land in this pod (see `tab-sync.ts`);
   * `structural` when a path came, went or moved, and `paths` when a peer
   * overwrote one this tab holds a change to. */
  onPeerChange: (
    notify: (structural: boolean, paths: readonly string[]) => void
  ) => () => void;
  persistence: WorkspacePersistence | null;
  pod: Nodepod;
}

/** How the facade opens its pod. The default boots a real `Nodepod`; tests
 * hand it the headless one, which is the only reason it is a parameter. */
export type OpenPodOpener = (options: PodOptions) => Promise<OpenPod>;

/** What `createWorkspace` takes: the ref being browsed and the pod's way back
 * to the committed bytes. */
export interface WorkspaceOptions {
  appId: string;
  /** The ref's branch name — also the pod's persistence key, with the app id. */
  branch: string;
  /** Read-only refs never persist and refuse every mutation. */
  editable: boolean;
  /** Reads the ref's tar; the composition wires the `source/archive` route. */
  fetchArchive: (ref: string) => Promise<Uint8Array>;
  /** The ref's listing (`source.tree`): what a fresh checkout stamps as base. */
  files: readonly TreeEntry[];
  /** The resolved commit of the browsed ref: what `stale` compares against. */
  sha: string;
  openPod?: OpenPodOpener;
  /** Where a failed IndexedDB save is reported; the page shows it (the pod
   * retries the save, but nothing else would tell the user). */
  onSaveError: SaveErrorReporter;
}

/** One file the push writes: text, or bytes carried as base64. */
export interface PushFile {
  content: string;
  encoding?: "base64";
  path: string;
}

/** One rename the push replays. */
export interface PushMove {
  from: string;
  to: string;
}

/** What the Changes panel's Push sends: the writes, the renames and the
 * deletions, in the shape the commit route takes. */
export interface PushPayload {
  deletes: string[];
  files: PushFile[];
  moves: PushMove[];
}

/** Where a push lands: the ref the commit goes to, the new branch the form
 * named (if any, in which case `target` is that branch), and the message the
 * commit carries. */
export interface WorkspacePush {
  branch?: string;
  message: string;
  target: string;
}

/** The workspace as the source UI talks to it. Every path in here is
 * checkout-relative (`relPath`/`projectPath` convert to the pod's own). */
export interface Workspace {
  /** The commit the pod is based on. The open always lands one (restoring the
   * saved workspace or checking the ref out), so this is never null. */
  readonly baseSha: string;
  /** The commit's text at `path`, read out of the pod's own blob cache: what a
   * pane shows for a file the checkout no longer has (a staged deletion). Null
   * when the commit holds no text file there. */
  baseText: (path: string) => Promise<string | null>;
  /** The Changes panel's rows, as of the last derive. */
  changes: () => WorkspaceChange[];
  close: () => Promise<void>;
  discard: (path: string) => Promise<void>;
  discardAll: () => Promise<void>;
  readonly editable: boolean;
  /** The pod's filesystem, as far as the UI reads it. Every other operation
   * on a path is a `Workspace` verb below, which the frame answers over the
   * RPC — this page never holds the pod. */
  readonly fs: SourceFs;
  /** Save the pod's pending writes now. The pod's own save is debounced, so
   * the page calls this from its lifecycle events (`pagehide`, a hidden tab)
   * and before the pod goes away. */
  flush: () => Promise<void>;
  /** The checkout's rows as the tree renders them: every file and every empty
   * folder. */
  listing: () => Promise<CheckoutListing>;
  /** Called after another tab's edits land in this workspace; `structural`
   * when a path came, went or moved, which the tree's rows have to follow, and
   * `paths` (checkout-relative, deduped) when a peer overwrote a path this tab
   * also holds a change to — the conflict the Changes panel names. */
  onPeerChange: (
    notify: (structural: boolean, paths: readonly string[]) => void
  ) => () => void;
  mkdir: (path: string) => Promise<void>;
  onChanges: (notify: (changes: WorkspaceChange[]) => void) => () => void;
  /** Send every unpushed change to `request` — a branch name, which may or
   * may not be the pod's own — and settle the pod on what that leaves it
   * holding. The frame builds the payload; `commit` (this page's own call to
   * the commit route, with the session's cookies) writes it. The frame is
   * never able to commit by itself: only a call from here, on the user's
   * Push, reaches the route. */
  push: (
    request: WorkspacePush,
    commit: (payload: PushPayload) => Promise<{ sha: string }>
  ) => Promise<void>;
  refresh: () => Promise<void>;
  remove: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /** Put the committed bytes of `path` back (a staged deletion returns). */
  restore: (path: string) => Promise<void>;
  /** The browsed tip when it is not the commit the pod is based on. */
  stale: string | null;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  writeText: (path: string, text: string) => Promise<void>;
}
