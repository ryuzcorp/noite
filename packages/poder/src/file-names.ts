// Flat, fixed-length SQLite filenames for the pod VFS: the pod's wa-sqlite
// refuses database paths longer than 56 chars, so every database lives at
// `<stateDir>/db/<kind>-<16 hex>.sqlite` and a JSON index maps files back
// to bindings for debugging.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SqliteKind = "d1" | "do" | "kv";

export interface DbIndexEntry {
  binding: string;
  kind: SqliteKind;
  name: string;
}

export const dbDir = (stateDir: string): string => path.join(stateDir, "db");

export const ensureDbDir = (stateDir: string): string => {
  const dir = dbDir(stateDir);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Fixed-length database file; key parts are hashed (joined with NUL). */
export const sqliteDbFile = (
  stateDir: string,
  kind: SqliteKind,
  parts: string[]
): string => {
  const hash = createHash("sha256")
    .update([kind, ...parts].join("\0"), "utf-8")
    .digest("hex")
    .slice(0, 16);
  return path.join(dbDir(stateDir), `${kind}-${hash}.sqlite`);
};

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- debug index keyed by filename; values follow the DbIndexEntry contract.
type DbIndex = Record<string, DbIndexEntry>;

const readDbIndex = (stateDir: string): DbIndex => {
  try {
    // SAFETY: index.json is poder-written; a corrupt index reads as empty and is rebuilt below.
    return JSON.parse(
      readFileSync(path.join(dbDir(stateDir), "index.json"), "utf-8")
    ) as DbIndex;
  } catch {
    return {};
  }
};

/** Best-effort debug index; never fails database setup. */
export const recordDbIndex = (
  stateDir: string,
  file: string,
  entry: DbIndexEntry
): void => {
  try {
    const index = readDbIndex(stateDir);
    index[path.basename(file)] = entry;
    writeFileSync(
      path.join(dbDir(stateDir), "index.json"),
      JSON.stringify(index, null, 2)
    );
  } catch {
    // Best-effort: the database itself is already open.
  }
};
