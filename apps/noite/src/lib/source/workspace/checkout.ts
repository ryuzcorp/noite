//! Filling the pod with a ref, and the two files that describe what landed.
//! The archive arrives as an injected fetch (the runner's route owns the
//! network), the tar reader writes the checkout, and every committed blob is
//! kept beside it in a content-addressed cache — after a checkout a diff or a
//! discard never has to ask for those bytes again.

import type { TreeEntry } from "../../runner";
import { formatMode, gitBlobSha } from "./git";
import {
  BASE_FILE,
  JOURNAL_FILE,
  META_ROOT,
  OBJECTS_DIR,
  PROJECT_ROOT,
  parentDir,
  projectPath,
} from "./types";
import type {
  BaseEntry,
  BaseIndex,
  GitMode,
  Journal,
  WorkspaceFs,
} from "./types";

/** A tar header is one block; every body is padded to whole blocks too. */
const BLOCK = 512;

const DECODER = new TextDecoder();

const ENCODER = new TextEncoder();

/** The NUL-terminated text of a header field (`name`, `mode`, `linkname`…). */
const field = (header: Uint8Array, start: number, length: number): string => {
  const slice = header.subarray(start, start + length);
  const nul = slice.indexOf(0);

  return DECODER.decode(nul === -1 ? slice : slice.subarray(0, nul));
};

/** A header number: octal digits, or the base-256 form tar uses past 8 GiB.
 * The form is flagged by the top bit of the first byte, which is why the first
 * byte's value is reduced rather than masked. */
const octal = (header: Uint8Array, start: number, length: number): number => {
  const slice = header.subarray(start, start + length);
  const first = slice[0] ?? 0;

  if (first >= 0x80) {
    let value = first - 0x80;

    for (const byte of slice.subarray(1)) {
      value = value * 256 + byte;
    }

    return value;
  }

  const text = field(header, start, length).trim();

  return text === "" ? 0 : Number.parseInt(text, 8);
};

/** One file a tar holds. Directory headers are not entries — the checkout
 * makes the directories its files need — and a symlink arrives as its target's
 * text, which is exactly the blob git committed for it. */
export interface TarEntry {
  bytes: Uint8Array;
  gitMode: GitMode;
  name: string;
}

/** The `key=value` records of a pax header block (`path=`, `linkpath=`,
 * `size=`…), which override the following entry's own header fields. */
const paxRecords = (block: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>();

  for (const line of DECODER.decode(block).split("\n")) {
    const space = line.indexOf(" ");
    const equals = line.indexOf("=", space + 1);

    if (space === -1 || equals === -1) {
      continue;
    }

    records.set(line.slice(space + 1, equals), line.slice(equals + 1));
  }

  return records;
};

/** Every regular file and symlink an archive holds. `git archive` writes ustar
 * with `prefix` split names and reaches for pax (or GNU long names) only when
 * a path or a link target does not fit a header field. */
export const readTar = (archive: Uint8Array): TarEntry[] => {
  const entries: TarEntry[] = [];
  let pax = new Map<string, string>();
  let longName: string | null = null;
  let longLink: string | null = null;
  let offset = 0;

  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const size = octal(header, 124, 12);
    const body = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCodePoint(header[156] ?? 0);

    if (type === "x") {
      pax = paxRecords(body);
      continue;
    }

    if (type === "L") {
      longName = DECODER.decode(body);
      continue;
    }

    if (type === "K") {
      longLink = DECODER.decode(body);
      continue;
    }

    const prefix = field(header, 345, 155);
    const name = longName ?? pax.get("path") ?? field(header, 0, 100);
    const link = longLink ?? pax.get("linkpath") ?? field(header, 157, 100);
    const entryName = prefix === "" ? name : `${prefix}/${name}`;
    longName = null;
    longLink = null;
    pax = new Map();

    if (type === "5") {
      continue;
    }

    if (type === "2") {
      entries.push({
        bytes: ENCODER.encode(link),
        gitMode: "120000",
        name: entryName,
      });
      continue;
    }

    if (type === "0" || type === "") {
      entries.push({
        bytes: body,
        gitMode: formatMode(octal(header, 100, 8)),
        name: entryName,
      });
    }
  }

  return entries;
};

/** What a checkout needs: which commit, the listing that names its blobs, and
 * the way to its tar (the runner's `source/archive` route, injected). */
export interface CheckoutInput {
  fetchArchive: (ref: string) => Promise<Uint8Array>;
  files: readonly TreeEntry[];
  sha: string;
}

/** A record with its keys in order, so the files the workspace writes have one
 * shape whoever wrote them. */
const sortKeys = <T>(record: Record<string, T>) => {
  const sorted: Record<string, T> = {};

  for (const key of Object.keys(record).toSorted()) {
    const value = record[key];

    if (value !== undefined) {
      sorted[key] = value;
    }
  }

  return sorted;
};

/** The JSON in `text` as the shape `is` accepts, or an error naming the file
 * that does not hold one. A file the workspace cannot read is refused rather
 * than guessed at, because guessing would re-checkout over unpushed work. */
const parseJson = <T>(
  text: string,
  file: string,
  what: string,
  is: (value: unknown) => value is T
): T => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`workspace: ${file} is not valid JSON`, { cause: error });
  }

  if (!is(parsed)) {
    throw new Error(`workspace: ${file} does not hold a ${what}`);
  }

  return parsed;
};

const isText = (value: unknown): value is string => typeof value === "string";

const isEntry = (value: unknown): value is BaseEntry =>
  typeof value === "object" &&
  value !== null &&
  "mode" in value &&
  typeof value.mode === "string" &&
  "sha" in value &&
  typeof value.sha === "string";

/** Whether every value in `value` is a `BaseEntry`. */
const isEntryRecord = (value: unknown): value is Record<string, BaseEntry> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).every(isEntry);
};

/** Whether every value in `value` is a committed path. */
const isMoveRecord = (value: unknown): value is Record<string, string> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).every(isText);
};

const isBaseIndex = (value: unknown): value is BaseIndex =>
  typeof value === "object" &&
  value !== null &&
  "baseSha" in value &&
  typeof value.baseSha === "string" &&
  "entries" in value &&
  isEntryRecord(value.entries);

/** A move journal, whose values are the committed paths. */
const isJournal = (value: unknown): value is Journal => isMoveRecord(value);

/** The base index of a commit, as the archive laid it out. */
export const readBase = async (fs: WorkspaceFs): Promise<BaseIndex | null> => {
  if (!(await fs.exists(BASE_FILE))) {
    return null;
  }

  return parseJson(
    await fs.readFile(BASE_FILE, "utf-8"),
    "base.json",
    "base index",
    isBaseIndex
  );
};

/** `index` as `base.json`, keys in order. */
export const writeBase = async (
  fs: WorkspaceFs,
  index: BaseIndex
): Promise<void> => {
  const written: BaseIndex = {
    baseSha: index.baseSha,
    entries: sortKeys(index.entries),
  };

  await fs.mkdir(META_ROOT, { recursive: true });
  await fs.writeFile(BASE_FILE, `${JSON.stringify(written, null, 2)}\n`);
};

/** The move journal; an absent file is an empty one. */
export const readJournal = async (fs: WorkspaceFs): Promise<Journal> => {
  if (!(await fs.exists(JOURNAL_FILE))) {
    return {};
  }

  return parseJson(
    await fs.readFile(JOURNAL_FILE, "utf-8"),
    "moves.json",
    "move journal",
    isJournal
  );
};

/** Drop the journal. An empty journal is no file at all. */
export const clearJournal = async (fs: WorkspaceFs): Promise<void> => {
  await fs.rm(JOURNAL_FILE, { force: true });
};

export const writeJournal = async (
  fs: WorkspaceFs,
  journal: Journal
): Promise<void> => {
  if (Object.keys(journal).length === 0) {
    await clearJournal(fs);

    return;
  }

  await fs.mkdir(META_ROOT, { recursive: true });
  await fs.writeFile(
    JOURNAL_FILE,
    `${JSON.stringify(sortKeys(journal), null, 2)}\n`
  );
};

/** Where the committed bytes of `sha` are kept. */
export const objectPath = (sha: string): string => `${OBJECTS_DIR}/${sha}`;

/** The committed bytes of one blob, or null when this pod never cached it. */
export const readObject = async (
  fs: WorkspaceFs,
  sha: string
): Promise<Uint8Array | null> => {
  const path = objectPath(sha);

  return (await fs.exists(path)) ? fs.readFile(path) : null;
};

/** Keep one committed blob, so a diff and a discard have it without the
 * network. */
export const writeObject = async (
  fs: WorkspaceFs,
  sha: string,
  bytes: Uint8Array
): Promise<void> => {
  await fs.mkdir(OBJECTS_DIR, { recursive: true });
  await fs.writeFile(objectPath(sha), bytes);
};

/** Check `sha` out into the pod: fetch its tar, write the checkout, cache
 * every committed blob and stamp `base.json`. The base index is the archive's
 * own listing — a path the archive does not hold is not part of the branch,
 * whatever the tree listing said about it. */
export const checkout = async (
  fs: WorkspaceFs,
  input: CheckoutInput
): Promise<void> => {
  const { fetchArchive, files, sha } = input;
  const entries = readTar(await fetchArchive(sha));

  if (entries.length === 0 && files.length > 0) {
    throw new Error("workspace: the archive held no files");
  }

  const listed = new Map(files.map((file) => [file.path, file.sha]));
  // A checkout replaces the branch: anything the pod held for the project goes.
  await fs.rm(PROJECT_ROOT, { force: true, recursive: true });
  await fs.mkdir(PROJECT_ROOT, { recursive: true });
  await fs.mkdir(OBJECTS_DIR, { recursive: true });
  const base: Record<string, BaseEntry> = {};

  const written = await Promise.all(
    entries.map(async (entry): Promise<[string, BaseEntry]> => {
      const abs = projectPath(entry.name);
      await fs.mkdir(parentDir(abs), { recursive: true });
      await fs.writeFile(abs, entry.bytes);
      const blob = listed.get(entry.name) ?? (await gitBlobSha(entry.bytes));
      await writeObject(fs, blob, entry.bytes);

      return [entry.name, { mode: entry.gitMode, sha: blob }];
    })
  );

  for (const [path, entry] of written) {
    base[path] = entry;
  }

  await writeBase(fs, { baseSha: sha, entries: base });
  await clearJournal(fs);
};
