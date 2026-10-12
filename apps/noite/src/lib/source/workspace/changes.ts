//! What the pod holds against what the commit said. One derive walks the
//! checkout, hashes only what it has to, and answers the panel's rows: a
//! rename the journal knows, a rename the blob ids give away (someone moved a
//! file without telling the UI), an edit, a new file, a staged removal.
//!
//! Empty directories are not changes — git cannot commit one — and the base
//! bytes always come from the pod's own object cache, never the network.

import { readObject } from "./checkout";
import { gitBlobSha, hashKey, isBinary } from "./git";
import { PROJECT_ROOT, projectPath, relPath } from "./types";
import type {
  BaseIndex,
  ChangeKind,
  CheckoutListing,
  HashCache,
  WorkspaceChange,
  WorkspaceFs,
  WorkspaceState,
} from "./types";

const DECODER = new TextDecoder();

/** One file the walk found, checkout-relative. */
export interface DiskFile {
  mtime: number;
  path: string;
  size: number;
}

/** One file's blob id, with the bytes when computing the id had to read them:
 * a file that had to be hashed is the one the panel is about to show. */
export interface ShaDigest {
  bytes: Uint8Array | null;
  sha: string;
}

/** What a row is built from: the file's bytes when the hash already read them,
 * the committed side read from the object cache. */
interface RowInput {
  base: BaseIndex;
  bytes: Uint8Array | null;
  fs: WorkspaceFs;
  kind: ChangeKind;
  /** For a move: the committed path the file came from. */
  origin?: string;
  path: string;
}

/** Every file under `dir`, and the directories that hold no file anywhere
 * under them: the tree draws those as rows of their own, because nothing else
 * would. */
interface Walked {
  dirs: string[];
  files: DiskFile[];
}

/** Installed dependencies (`npm install`, the preview's installs) live in the
 * checkout but are never part of it: Nodepod doesn't persist them either. */
const DEPENDENCY_DIR = "node_modules";

/** Walk `dir` once: the files it holds at this level, then the children of
 * every folder under it (dependency folders skipped), in name order. */
const walk = async (fs: WorkspaceFs, dir: string): Promise<Walked> => {
  const names = await fs.readdir(dir);
  const entries = await Promise.all(
    names.toSorted().map(async (name) => {
      const abs = `${dir}/${name}`;
      return { abs, stat: await fs.stat(abs) };
    })
  );
  const files: DiskFile[] = [];
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.stat.isFile) {
      files.push({
        mtime: entry.stat.mtime,
        path: relPath(entry.abs),
        size: entry.stat.size,
      });
    } else if (
      entry.stat.isDirectory &&
      !entry.abs.endsWith(`/${DEPENDENCY_DIR}`)
    ) {
      folders.push(entry.abs);
    }
  }
  const dirs: string[] = [];
  const children = await Promise.all(
    folders.map(async (folder) => ({ folder, walked: await walk(fs, folder) }))
  );
  for (const { folder, walked } of children) {
    files.push(...walked.files);
    dirs.push(...walked.dirs);
    if (walked.files.length === 0) {
      dirs.push(relPath(folder));
    }
  }
  return { dirs, files };
};

/** Every file in the checkout, in path order — the same order the base index
 * keeps its keys in. */
export const listFiles = async (fs: WorkspaceFs): Promise<DiskFile[]> => {
  const walked = await walk(fs, PROJECT_ROOT);
  return walked.files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
};

/** The checkout as the tree renders it: every file, plus the folders that hold
 * no file under them. A folder like that is the user's own placeholder — git
 * cannot commit one, so this listing is the only place it exists. */
export const listCheckout = async (
  fs: WorkspaceFs
): Promise<CheckoutListing> => {
  const { dirs, files } = await walk(fs, PROJECT_ROOT);
  return {
    dirs: dirs.toSorted(),
    files: files.map((file) => file.path).toSorted(),
  };
};

/** The blob id of `file`'s bytes. A file whose size and mtime both stand still
 * since the last derive is answered from the cache without reading it, which
 * is what keeps an unchanged tree cheap. */
export const fileSha = async (
  fs: WorkspaceFs,
  cache: HashCache,
  file: DiskFile
): Promise<ShaDigest> => {
  const key = hashKey(file.path, file.size, file.mtime);
  const held = cache.get(file.path);
  if (held !== undefined && held.key === key) {
    return { bytes: null, sha: held.sha };
  }
  const bytes = await fs.readFile(projectPath(file.path));
  const sha = await gitBlobSha(bytes);
  cache.set(file.path, { key, sha });
  return { bytes, sha };
};

/** The right-hand side of a row: the file's text, or its byte count when the
 * bytes are not text — the panel lists such a row, it cannot diff it. */
const afterSide = (bytes: Uint8Array): { after: string; binary?: number } =>
  isBinary(bytes)
    ? { after: "", binary: bytes.byteLength }
    : { after: DECODER.decode(bytes) };

/** The left-hand side: the committed text of `path`, empty when the commit
 * has nothing there, and `loading` when this pod holds no copy of the blob
 * (there is nothing to diff, and nothing a discard could put back). */
const committedSide = async (
  fs: WorkspaceFs,
  base: BaseIndex,
  path: string
): Promise<{ loading: boolean; text: string }> => {
  const entry = base.entries[path];
  if (entry === undefined) {
    return { loading: false, text: "" };
  }
  const bytes = await readObject(fs, entry.sha);
  if (bytes === null) {
    return { loading: true, text: "" };
  }
  return { loading: false, text: isBinary(bytes) ? "" : DECODER.decode(bytes) };
};

/** One row whose file is on disk: an edit, a new file, or a move. */
const makeRow = async (input: RowInput): Promise<WorkspaceChange> => {
  const { base, bytes, fs, kind, origin, path } = input;
  const after = afterSide(bytes ?? (await fs.readFile(projectPath(path))));
  const before = await committedSide(fs, base, origin ?? path);
  const row: WorkspaceChange = {
    after: after.after,
    before: before.text,
    kind,
    loading: before.loading,
    path,
  };
  if (after.binary !== undefined) {
    row.binary = after.binary;
  }
  if (origin !== undefined) {
    row.movedFrom = origin;
  }
  return row;
};

/** A staged removal: the commit's text on the left, nothing on the right. */
const deletedRow = async (
  fs: WorkspaceFs,
  base: BaseIndex,
  path: string
): Promise<WorkspaceChange> => {
  const before = await committedSide(fs, base, path);
  return {
    after: "",
    before: before.text,
    kind: "deleted",
    loading: before.loading,
    path,
  };
};

/** One disk file's first verdict: a row already, a new path waiting to be
 * paired with a deletion by its blob id, or nothing at all. */
type Classified =
  | { change: WorkspaceChange }
  | { digest: ShaDigest; file: DiskFile }
  | null;

/** A new path's row: `moved` when a deleted path with the same bytes gave it
 * an origin, `added` when nothing did. */
interface Paired {
  change: WorkspaceChange;
  moved: boolean;
}

/** Every change the pod holds against `state.base`, in the order the panel
 * shows them: moves (with their edit riding along), then edits, new files and
 * staged removals. */
export const deriveChanges = async (
  state: WorkspaceState
): Promise<WorkspaceChange[]> => {
  const { base, cache, fs, journal } = state;
  const disk = await listFiles(fs);
  const onDisk = new Set(disk.map((file) => file.path));
  // A journaled move only pairs while the file it names is where it landed and
  // the commit's copy is gone: a path that still holds its own file is a copy.
  const movedFrom = new Map<string, string>();
  for (const [current, committed] of Object.entries(journal)) {
    if (onDisk.has(current) && !onDisk.has(committed)) {
      movedFrom.set(current, committed);
    }
  }
  const classified = await Promise.all(
    disk.map(async (file): Promise<Classified> => {
      const digest = await fileSha(fs, cache, file);
      const origin = movedFrom.get(file.path);
      if (origin !== undefined) {
        return {
          change: await makeRow({
            base,
            bytes: digest.bytes,
            fs,
            kind: "moved",
            origin,
            path: file.path,
          }),
        };
      }
      const entry = base.entries[file.path];
      if (entry === undefined) {
        return { digest, file };
      }
      if (entry.sha === digest.sha) {
        return null;
      }
      return {
        change: await makeRow({
          base,
          bytes: digest.bytes,
          fs,
          kind: "modified",
          path: file.path,
        }),
      };
    })
  );
  const moved: WorkspaceChange[] = [];
  const modified: WorkspaceChange[] = [];
  const fresh: { digest: ShaDigest; file: DiskFile }[] = [];
  for (const item of classified) {
    if (item === null) {
      continue;
    }
    if ("change" in item) {
      const bucket = item.change.kind === "moved" ? moved : modified;
      bucket.push(item.change);
      continue;
    }
    fresh.push(item);
  }
  // A path the commit had that is gone and that no journaled move claimed is
  // the other half of a move nobody told the UI about — or a deletion.
  const claimed = new Set(movedFrom.values());
  const gone = Object.keys(base.entries)
    .filter((path) => !(onDisk.has(path) || claimed.has(path)))
    .toSorted();
  const bySha = new Map<string, string[]>();
  for (const path of gone) {
    const entry = base.entries[path];
    if (entry !== undefined) {
      const bucket = bySha.get(entry.sha);
      if (bucket === undefined) {
        bySha.set(entry.sha, [path]);
      } else {
        bucket.push(path);
      }
    }
  }
  // The shifts happen before each row is built, in the candidates' order, so a
  // path pairs with the first deletion that holds the same bytes.
  const consumed = new Set<string>();
  const paired = await Promise.all(
    fresh.map(async (item): Promise<Paired> => {
      const origin = bySha.get(item.digest.sha)?.shift();
      if (origin === undefined) {
        return {
          change: await makeRow({
            base,
            bytes: item.digest.bytes,
            fs,
            kind: "added",
            path: item.file.path,
          }),
          moved: false,
        };
      }
      consumed.add(origin);
      return {
        change: await makeRow({
          base,
          bytes: item.digest.bytes,
          fs,
          kind: "moved",
          origin,
          path: item.file.path,
        }),
        moved: true,
      };
    })
  );
  const added: WorkspaceChange[] = [];
  for (const item of paired) {
    (item.moved ? moved : added).push(item.change);
  }
  const deleted = await Promise.all(
    gone
      .filter((path) => !consumed.has(path))
      .map((path) => deletedRow(fs, base, path))
  );
  return [...moved, ...modified, ...added, ...deleted];
};
