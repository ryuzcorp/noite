//! The source page's edit session: the browsed commit's tree and the buffers
//! edited against it, held in the page and nowhere else. One module, pure —
//! it never reads a blob, writes a file or talks to the runner. The browser
//! reads blobs into it, the editor writes text into it, and `commitInput`
//! turns it back into the one `POST /source/commit` body the runner accepts.
//!
//! The session is the whole truth about unsaved work: there is no persistence,
//! no second tab and no filesystem behind it. Leaving the page drops it, which
//! is why the browser warns first (see `./browser`).
//!
//! A path is in exactly one of these states:
//!
//! | in `base` | in `buffers` | in `deletes` | a move target | change |
//! | --- | --- | --- | --- | --- |
//! | yes | no  | no  | no  | untouched |
//! | yes | yes | no  | no  | `modified` (or untouched once the text matches) |
//! | yes | no  | yes | no  | `deleted` |
//! | yes | yes | no  | yes | `moved` (modified too, when the text differs) |
//! | yes | no  | no  | yes | `moved`, bytes carried by the move |
//! | no  | yes | no  | n/a | `added` (text or an upload) |

import type {
  RunnerTree,
  SourceCommitFile,
  SourceCommitMove,
  TreeEntry,
} from "../runner";

/** What a change does to its path. `moved` covers a rename, whether or not the
 * bytes changed on the way. */
export type ChangeKind = "added" | "deleted" | "modified" | "moved";

/** An uploaded file as the commit carries it: base64 plus its decoded size,
 * which the row shows where a text diff has nothing to compare. */
export interface Upload {
  bytes: number;
  content: string;
}

/** One live buffer: the text the editor holds, the committed text it is
 * compared against (`null` for a file this session added), and the upload when
 * the file is bytes rather than text. */
export interface SourceBuffer {
  /** The committed text at the path (the diff's `before`); null for an add. */
  base: string | null;
  text: string;
  upload?: Upload;
}

/** One row of the Changes panel: what a path holds now and what the browsed
 * commit holds at the same path or, for a move, at its origin. */
export interface SourceChange {
  /** The text the commit would write ("" for a deletion or an upload). */
  after: string;
  /** The committed text, or null when this session never read it — a deletion
   * carries the row, not bytes. */
  before: string | null;
  /** Decoded byte count of an upload. */
  bytes?: number;
  kind: ChangeKind;
  /** For a move: the committed path the file came from. */
  movedFrom?: string;
  path: string;
}

/** What `commitInput` hands the commit route: the runner's own vocabulary. */
export interface CommitInput {
  deletes: string[];
  files: SourceCommitFile[];
  moves: SourceCommitMove[];
}

/** The session: the browsed commit's files, every live buffer, the new paths
 * this session adds, and the deletes staged over committed paths. */
export interface EditSession {
  /** The commit the tree below was read at. */
  baseSha: string;
  /** Committed path → its entry, in path order. */
  base: Map<string, TreeEntry>;
  /** The live text of every path opened or added, dirty or not: `changes`
   * filters the ones that match the commit. */
  buffers: Map<string, SourceBuffer>;
  deletes: Set<string>;
  /** Destination → the committed path it came from. */
  moves: Map<string, string>;
}

/** A refusal from the session, worded for the user: the tree flow paints it. */
export type SessionResult =
  | { ok: true; session: EditSession }
  | { ok: false; reason: string };

/** An empty session, for a page that has not opened a commit yet. */
export const emptySession = (): EditSession => ({
  base: new Map(),
  baseSha: "",
  buffers: new Map(),
  deletes: new Set(),
  moves: new Map(),
});

/** A session over a commit's listing: nothing edited yet. */
export const openSession = (tree: RunnerTree): EditSession => ({
  base: new Map(tree.files.map((entry) => [entry.path, entry])),
  baseSha: tree.sha,
  buffers: new Map(),
  deletes: new Set(),
  moves: new Map(),
});

/** Whether the session knows `path` at all: a committed file, a live buffer,
 * or the destination of a move. A row outside this set has nothing to read —
 * pierre's inline-add placeholder (`untitled`) is one, and so is a row a
 * rebuild delivered a stale selection for. */
export const holdsPath = (session: EditSession, path: string): boolean =>
  session.base.has(path) ||
  session.buffers.has(path) ||
  session.moves.has(path);

/** The destination a committed path was moved to, if any. */
const moveTarget = (session: EditSession, path: string): string | undefined => {
  for (const [to, from] of session.moves) {
    if (from === path) {
      return to;
    }
  }

  return undefined;
};

/** Path order, bytewise like git's (uppercase before lowercase), so the tree,
 * the rows and the commit body always list the same way. */
export const byPath = (left: string, right: string): number =>
  left < right ? -1 : 1;

/** The copy every mutation starts from: one map, set or not replaced by the
 * change alone, so two writes never share a mutable structure. */
const copy = (session: EditSession): EditSession => ({
  base: session.base,
  baseSha: session.baseSha,
  buffers: new Map(session.buffers),
  deletes: new Set(session.deletes),
  moves: new Map(session.moves),
});

/** Record the committed text of `path` without making it dirty: the editor
 * hands this the blob it painted, so a later `edit` has a diff base. */
export const prime = (
  session: EditSession,
  path: string,
  base: string
): EditSession => {
  if (!session.base.has(path) || session.buffers.has(path)) {
    return session;
  }

  const next = copy(session);

  // An unedited buffer is not a change: the row appears with the first edit,
  // and `changes` drops this one again while `text === base`.
  next.buffers.set(path, { base, text: base });

  return next;
};

/** A buffer shaped for its upload, if it has one. */
const spell = (
  buffer: { base: string | null; text: string },
  upload: Upload | undefined
): SourceBuffer => (upload === undefined ? buffer : { ...buffer, upload });

/** Write the editor's text for `path` into its buffer. The first write of a
 * file primes the buffer with the committed text the caller read. */
export const edit = (
  session: EditSession,
  path: string,
  text: string,
  committed: string | null
): EditSession => {
  const held = session.buffers.get(path);
  const base = held?.base ?? committed;
  const next = copy(session);

  if (base === null && session.base.has(path)) {
    // A committed file being edited with no base text read: nothing can tell
    // whether it changed, so the write is refused rather than guessed.
    return session;
  }

  next.buffers.set(path, spell({ base, text }, held?.upload));

  return next;
};

/** Add a new file's text. Adding a committed path is refused: that is an
 * `edit`, and a second definition of the same row would shadow it. */
export const add = (
  session: EditSession,
  path: string,
  text: string
): SessionResult => {
  if (session.base.has(path) || path === "") {
    return { ok: false, reason: `${path} already exists` };
  }

  if (moveTarget(session, path) !== undefined) {
    return { ok: false, reason: `${path} was moved` };
  }

  const next = copy(session);
  next.buffers.set(path, { base: null, text });

  return { ok: true, session: next };
};

/** Add an uploaded file: its bytes ride the commit as base64. */
export const addUpload = (
  session: EditSession,
  path: string,
  upload: Upload
): SessionResult => {
  if (session.base.has(path) || path === "") {
    return { ok: false, reason: `${path} already exists` };
  }

  const next = copy(session);
  next.buffers.set(path, { base: null, text: "", upload });

  return { ok: true, session: next };
};

/** Forget every buffer at `path` and stop staging its deletion: the row goes
 * back to what the commit holds. A move's destination keeps its move (the
 * bytes still belong at the new path) while the text goes back to the base. */
export const discard = (session: EditSession, path: string): EditSession => {
  const next = copy(session);
  next.buffers.delete(path);
  next.deletes.delete(path);

  return next;
};

/** Discard every change: back to the commit the session was opened at. */
export const discardAll = (session: EditSession): EditSession => ({
  base: session.base,
  baseSha: session.baseSha,
  buffers: new Map(),
  deletes: new Set(),
  moves: new Map(),
});

/** Delete `path`: an add is simply forgotten, a committed file is staged for
 * the commit's `deletes`, and a moved file is deleted at its destination while
 * its origin drops the move (the old path stays gone). */
export const remove = (session: EditSession, path: string): EditSession => {
  const next = copy(session);
  const origin = next.moves.get(path);

  next.buffers.delete(path);

  if (origin !== undefined) {
    // Deleting a move's destination removes the file the move carried.
    next.moves.delete(path);
    next.deletes.add(origin);

    return next;
  }

  if (session.base.has(path)) {
    next.deletes.add(path);
  }

  return next;
};

/** Rename `from` to `to`. A committed file's rename becomes a move (the
 * runner re-points the blob without reading it); an added file's is the same
 * buffer under the new path. Only the leaf changes in the tree's inline
 * rename, but a folder drag renames every path under it and calls this once
 * per file. */
export const move = (
  session: EditSession,
  from: string,
  to: string
): SessionResult => {
  if (from === to || to === "") {
    return { ok: false, reason: `"${to}" is not a new name` };
  }

  if (session.buffers.has(to) || session.base.has(to)) {
    return { ok: false, reason: `${to} already exists` };
  }

  if (moveTarget(session, to) !== undefined) {
    return { ok: false, reason: `${to} was moved` };
  }

  const next = copy(session);
  const buffer = next.buffers.get(from);

  if (buffer !== undefined) {
    next.buffers.delete(from);
    next.buffers.set(to, buffer);
  }

  if (session.deletes.has(from)) {
    next.deletes.delete(from);
    next.deletes.add(to);

    return { ok: true, session: next };
  }

  if (buffer !== undefined && buffer.base === null) {
    // An added file: renaming its buffer is the whole move.
    return { ok: true, session: next };
  }

  const origin =
    session.moves.get(from) ?? (session.base.has(from) ? from : null);

  if (origin === null) {
    // A path this session never had and the commit does not hold: nothing to
    // move, and the tree cannot have shown a row for it.
    return { ok: false, reason: `${from} does not exist` };
  }

  if (session.moves.has(from)) {
    next.moves.delete(from);
  }

  next.moves.set(to, origin);

  return { ok: true, session: next };
};

/** Whether the change at `path` is a real change: an add is always one, a
 * modification only while the text differs from the commit's. */
const changed = (
  session: EditSession,
  path: string,
  buffer: SourceBuffer
): boolean =>
  buffer.base === null ||
  buffer.upload !== undefined ||
  buffer.text !== buffer.base ||
  session.moves.has(path);

/** Every change the commit would write, in path order. */
export const changes = (session: EditSession): SourceChange[] => {
  const rows = new Map<string, SourceChange>();

  for (const [path, buffer] of session.buffers) {
    if (!changed(session, path, buffer)) {
      continue;
    }

    const from = session.moves.get(path);

    // A buffer with no committed side is an add; otherwise the change is a
    // move when the session holds one, and a plain edit when it does not.
    const row: SourceChange = {
      after: buffer.text,
      before: buffer.base ?? "",
      kind: "modified",
      path,
    };

    if (buffer.base === null) {
      row.kind = "added";
    } else if (from !== undefined) {
      row.kind = "moved";
    }

    if (from !== undefined) {
      row.movedFrom = from;
    }

    if (buffer.upload !== undefined) {
      row.bytes = buffer.upload.bytes;
    }

    rows.set(path, row);
  }

  // A pure move (the bytes did not change) has no buffer row of its own.
  for (const [to, from] of session.moves) {
    if (rows.has(to)) {
      continue;
    }

    rows.set(to, {
      after: "",
      before: null,
      kind: "moved",
      movedFrom: from,
      path: to,
    });
  }

  for (const path of session.deletes) {
    rows.set(path, { after: "", before: null, kind: "deleted", path });
  }

  return [...rows.values()].toSorted((left, right) =>
    byPath(left.path, right.path)
  );
};

/** How many paths the session holds changes for (the bar's badge). */
export const changeCount = (session: EditSession): number =>
  changes(session).length;

/** The one commit body: every buffer that carries bytes, every move, every
 * staged deletion. A moved file is written only when its text changed — the
 * runner's move carries the blob, and writing the destination too would ask
 * it for the same path twice. */
export const commitInput = (session: EditSession): CommitInput => {
  const files: SourceCommitFile[] = [];

  for (const [path, buffer] of session.buffers) {
    if (buffer.upload !== undefined) {
      files.push({ content: buffer.upload.content, encoding: "base64", path });

      continue;
    }

    if (buffer.base !== null && buffer.text === buffer.base) {
      // Unchanged text: a move carries the blob, and nothing else writes it.
      continue;
    }

    files.push({ content: buffer.text, path });
  }

  return {
    deletes: [...session.deletes].toSorted(byPath),
    files: files.toSorted((left, right) => byPath(left.path, right.path)),
    moves: [...session.moves]
      .map(([to, from]) => ({ from, to }))
      .toSorted((left, right) => byPath(left.to, right.to)),
  };
};

/** Undo one row: a staged deletion comes back, and a move goes home (with any
 * edit made at the destination). An added file has nothing to undo — its
 * discard is what removes it. */
export const restore = (session: EditSession, path: string): EditSession => {
  if (session.deletes.has(path)) {
    const next = copy(session);
    next.deletes.delete(path);

    return next;
  }

  const from = session.moves.get(path);

  if (from === undefined) {
    return session;
  }

  const next = copy(session);
  next.moves.delete(path);
  const buffer = next.buffers.get(path);

  if (buffer !== undefined) {
    next.buffers.delete(path);
    next.buffers.set(from, buffer);
  }

  return next;
};
