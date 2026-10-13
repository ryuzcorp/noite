//! Reading the files a user picks or drops for a source upload, and the caps
//! one commit's upload is held to. Nothing here talks to the page: it turns a
//! `FileList` or a drop's `DataTransferItemList` into the `UploadRead`s the
//! browser turns into drafts, and answers whether those reads fit one commit.
//! The runner re-encodes the base64 back into bytes at push time, so the
//! classification here and `UPLOAD_LIMITS` have to match its contract.

import { bytesToBase64, formatBytes } from "../bytes";

/** What one commit's uploads may not exceed, in decoded bytes. The runner
 * enforces the same numbers server-side when it writes the files; these are
 * the brief's numbers, kept in one place so the page and the toast agree. */
export interface UploadLimits {
  /** Decoded bytes of a single uploaded file. */
  maxFileBytes: number;
  /** Decoded bytes of every file one commit writes. */
  maxTotalBytes: number;
  /** Files one commit writes. */
  maxFiles: number;
}

/** The numbers come from the upload brief (10 MiB per file, 25 MiB per commit,
 * 100 files per commit) and are the runner's too — a change belongs in both
 * this object and the runner's commit limits. */
export const UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 100,
  maxTotalBytes: 25 * 1024 * 1024,
};

/** The largest file that goes in as text rather than base64 — the cap the
 * source editor already works under. Anything bigger, or anything that is not
 * clean UTF-8, travels base64. */
export const TEXT_MAX_BYTES = 256 * 1024;

/** One file read off the user's disk: `text` when it is small and clean UTF-8,
 * `binary` (standard base64, no data: prefix) otherwise, `error` when it could
 * not be read at all. `path` is where it will land in the source tree. */
export type UploadRead =
  | { kind: "text"; path: string; text: string }
  | { kind: "binary"; path: string; base64: string; bytes: number }
  | { kind: "error"; path: string; reason: string };

/** The one UTF-8 reader: fatal, so a byte sequence that is not valid text
 * fails instead of decoding to U+FFFD (which would silently corrupt a file). */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The counterpart used to weigh text against the limits. */
const UTF8_ENCODER = new TextEncoder();

/** `bytes` as text when they are text at all: valid UTF-8 with no NUL byte (a
 * NUL means a binary file, whatever its extension), null otherwise. Size is
 * not asked here — `readOne` decides whether the text is small enough. */
const decodeText = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
};

/** Whether `bytes` are text at all (valid UTF-8, no NUL). Whether they are
 * small enough to draft is a separate question, asked by `readOne`. */
export const isTextBytes = (bytes: Uint8Array): boolean =>
  decodeText(bytes) !== null;

/** The decoded length of a base64 string (the runner's byte limits are on what
 * lands in the commit, not on the encoded text). */
export const base64Bytes = (base64: string): number => {
  let padding = 0;
  if (base64.endsWith("==")) {
    padding = 2;
  } else if (base64.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((base64.length * 3) / 4) - padding;
};

/** The reason a read failed when the platform gives none — the toast shows it,
 * so it stays a line a person can act on. */
const UNREADABLE = "Could not be read.";

/** Read one picked `File` at `path` into an `UploadRead`. Text is decoded only
 * when it could be drafted at all; every other file becomes base64 with its
 * byte count, which the runner wants before it decodes anything. */
const readOne = async (file: File, path: string): Promise<UploadRead> => {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = bytes.byteLength <= TEXT_MAX_BYTES ? decodeText(bytes) : null;
    if (text === null) {
      return {
        base64: bytesToBase64(bytes),
        bytes: bytes.byteLength,
        kind: "binary",
        path,
      };
    }
    return { kind: "text", path, text };
  } catch (error) {
    return {
      kind: "error",
      path,
      reason: error instanceof Error ? error.message : UNREADABLE,
    };
  }
};

/** Read the files an `<input type=file>` gave us (a drop without entries comes
 * here too). The browser only fills `webkitRelativePath` for a folder input; a
 * plain one knows the bare name and nothing of the folder it came from, which
 * is why directories need `readDroppedItems`. */
export const readPickedFiles = (
  files: FileList | readonly File[]
): Promise<UploadRead[]> =>
  Promise.all(
    [...files].map((file) =>
      readOne(file, file.webkitRelativePath || file.name)
    )
  );

/** One `readEntries` call. Chromium hands a directory's children out in
 * batches and only reports the end by resolving with none. */
const readEntriesBatch = (
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> => {
  const { promise, reject, resolve } =
    Promise.withResolvers<FileSystemEntry[]>();
  reader.readEntries(resolve, reject);
  return promise;
};

/** Every entry `reader` will hand out, batch after batch. */
const readAllEntries = async (
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> => {
  const entries: FileSystemEntry[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the batches come from one stateful reader: each call advances it, so they cannot run in parallel.
    const batch = await readEntriesBatch(reader);
    if (batch.length === 0) {
      return entries;
    }
    entries.push(...batch);
  }
};

/** The `File` behind a file entry — the entry API is callback-shaped. */
const fileOf = (entry: FileSystemFileEntry): Promise<File> => {
  const { promise, reject, resolve } = Promise.withResolvers<File>();
  entry.file(resolve, reject);
  return promise;
};

/** `entry` is a file (the DOM types give no discriminated entry, so the check
 * has to be a named one). */
const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry =>
  entry.isFile;

/** `entry` is a directory. */
const isDirectoryEntry = (
  entry: FileSystemEntry
): entry is FileSystemDirectoryEntry => entry.isDirectory;

/** Entries a drop leaves out unread (a project's `node_modules`, say), by the
 * entry and the path it would land at. */
export type DropSkip = (entry: FileSystemEntry, path: string) => boolean;

/** Walk one dropped entry: a file is read, a directory's subtree is read under
 * `path` (its place relative to the drop), and anything else — or anything
 * `skip` names — is left out. A directory that cannot be listed — or a file
 * the platform will not hand over — becomes an error read at its own path
 * instead of failing the whole drop.
 */
const readEntry = async (
  entry: FileSystemEntry,
  path: string,
  skip?: DropSkip
): Promise<UploadRead[]> => {
  if (skip?.(entry, path)) {
    return [];
  }
  try {
    if (isFileEntry(entry)) {
      return [await readOne(await fileOf(entry), path)];
    }
    if (isDirectoryEntry(entry)) {
      const children = await readAllEntries(entry.createReader());
      const nested = await Promise.all(
        children.map((child) => readEntry(child, `${path}/${child.name}`, skip))
      );
      return nested.flat();
    }
    return [];
  } catch (error) {
    return [
      {
        kind: "error",
        path,
        reason: error instanceof Error ? error.message : UNREADABLE,
      },
    ];
  }
};

/** One dropped item. `webkitGetAsEntry` is Chromium-only, so a browser without
 * it falls back to the plain file the item also carries. */
const readItem = async (
  item: DataTransferItem,
  skip?: DropSkip
): Promise<UploadRead[]> => {
  const entry = item.webkitGetAsEntry?.() ?? null;
  if (entry !== null) {
    return readEntry(entry, entry.name, skip);
  }
  const file = item.getAsFile();
  return file === null ? [] : [await readOne(file, file.name)];
};

/** Read a drop, directories and all: dropping a folder `assets` yields paths
 * like `assets/logo.png`. The items are snapshotted first, because a
 * `DataTransferItemList` empties once the drop event returns. Items that are
 * neither files nor directories (a dragged string) are skipped, and so is
 * whatever `skip` names. */
export const readDroppedItems = async (
  items: DataTransferItemList,
  skip?: DropSkip
): Promise<UploadRead[]> => {
  const reads = await Promise.all(
    [...items].map((item) => readItem(item, skip))
  );
  return reads.flat();
};

/** Why `reads` cannot go into one commit, or null when they fit. Only writes
 * count: an error read is the reader's problem, not the runner's. One breach
 * is reported — the first oversized file by path, else the total, else the
 * count. */
export const checkLimits = (
  reads: readonly UploadRead[],
  limits: UploadLimits
): string | null => {
  let total = 0;
  let files = 0;
  for (const read of reads) {
    if (read.kind === "error") {
      continue;
    }
    // A text write weighs what it will take as a source file: a character
    // count would undercount anything non-ASCII.
    const size =
      read.kind === "binary"
        ? read.bytes
        : UTF8_ENCODER.encode(read.text).byteLength;
    if (size > limits.maxFileBytes) {
      return `${read.path} is larger than ${formatBytes(limits.maxFileBytes)}.`;
    }
    total += size;
    files += 1;
  }
  if (total > limits.maxTotalBytes) {
    return `The upload is larger than ${formatBytes(limits.maxTotalBytes)} in total.`;
  }
  if (files > limits.maxFiles) {
    return `Up to ${limits.maxFiles} files per commit.`;
  }
  return null;
};
