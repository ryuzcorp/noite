// KV-compatible namespace over a SQLite file under `<stateDir>/db/` (see
// file-names.ts). `cacheTtl` is accepted and ignored, matching edge-cache
// semantics locally.

import { ensureDbDir, recordDbIndex, sqliteDbFile } from "./file-names.ts";
import { isString } from "./guards.ts";
import type { SqliteDatabase, SqliteDriver } from "./types.ts";

export type KvValueType = "text" | "json" | "arrayBuffer" | "stream";

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: KV metadata is caller-defined JSON.
type KvMetadata = Record<string, unknown>;

type KvDecodedValue =
  | string
  | number
  | boolean
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: KV JSON values are caller-defined.
  | KvMetadata
  | KvDecodedValue[]
  | null;

export interface KvGetOptions {
  type?: KvValueType;
  cacheTtl?: number;
}

export interface KvPutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: KvMetadata;
}

export interface KvListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface KvKey {
  name: string;
  expiration?: number;
  metadata?: KvMetadata;
}

export interface KvListResult {
  keys: KvKey[];
  list_complete: boolean;
  cursor?: string;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const encodeCursor = (offset: number): string =>
  Buffer.from(String(offset), "utf-8").toString("base64");

const decodeCursor = (cursor: string): number => {
  const offset = Number(Buffer.from(cursor, "base64").toString("utf-8"));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Invalid KV list cursor");
  }
  return offset;
};

const streamToBytes = async (
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- stream reads are sequential by protocol.
    const next = await reader.read();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export class PoderKV {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS kv_entries (key TEXT PRIMARY KEY, value BLOB NOT NULL, metadata TEXT, expiration INTEGER)"
    );
  }

  static open(
    sqlite: SqliteDriver,
    stateDir: string,
    binding: string,
    id: string
  ): PoderKV {
    ensureDbDir(stateDir);
    const file = sqliteDbFile(stateDir, "kv", [binding, id]);
    recordDbIndex(stateDir, file, { binding, kind: "kv", name: id });
    return new PoderKV(sqlite.open(file));
  }

  private readRow(key: string): {
    value: Uint8Array;
    metadata: string | null;
    expiration: number | null;
  } | null {
    const row = this.db
      .prepare(
        "SELECT value, metadata, expiration FROM kv_entries WHERE key = ?"
      )
      .get(key);
    if (row === undefined) {
      return null;
    }
    const expiration =
      row["expiration"] === null ? null : Number(row["expiration"]);
    if (expiration !== null && expiration <= nowSeconds()) {
      this.db.prepare("DELETE FROM kv_entries WHERE key = ?").run(key);
      return null;
    }
    const raw = row["value"];
    // SAFETY: BLOB columns come back as Uint8Array (checked above) or ArrayBuffer; nothing else reaches here.
    const value =
      raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    const metadata = row["metadata"] === null ? null : String(row["metadata"]);
    return { expiration, metadata, value };
  }

  private static decode(value: Uint8Array, type: KvValueType): KvDecodedValue {
    switch (type) {
      case "arrayBuffer": {
        // SAFETY: Uint8Array.from allocates an exact-size copy, so .buffer is that copy's ArrayBuffer.
        return Uint8Array.from(value).buffer as ArrayBuffer;
      }
      case "stream": {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        });
      }
      case "json": {
        // SAFETY: JSON.parse yields caller-shaped JSON; the requested KvValueType tells callers how to narrow it.
        return JSON.parse(new TextDecoder().decode(value)) as KvDecodedValue;
      }
      case "text": {
        return new TextDecoder().decode(value);
      }
      default: {
        throw new Error("Unknown KV value type");
      }
    }
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async KV API; sync faults surface as rejections.
  async get(
    key: string,
    options: KvGetOptions | KvValueType = "text"
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: KV returns text/json/bytes/stream per requested type.
  ): Promise<unknown> {
    const type = isString(options) ? options : (options.type ?? "text");
    const row = this.readRow(key);
    if (row === null) {
      return null;
    }
    return PoderKV.decode(row.value, type);
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async KV API; sync faults surface as rejections.
  async getWithMetadata(
    key: string,
    options: KvGetOptions | KvValueType = "text"
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: KV returns text/json/bytes/stream per requested type.
  ): Promise<{ value: unknown; metadata: KvMetadata | null }> {
    const type = isString(options) ? options : (options.type ?? "text");
    const row = this.readRow(key);
    if (row === null) {
      return { metadata: null, value: null };
    }
    // SAFETY: metadata was serialized by put() via JSON.stringify; parse restores the caller's JSON object.
    const metadata =
      row.metadata === null ? null : (JSON.parse(row.metadata) as KvMetadata);
    return { metadata, value: PoderKV.decode(row.value, type) };
  }

  async put(
    key: string,
    value:
      | string
      | Uint8Array
      | ArrayBuffer
      | ArrayBufferView
      | ReadableStream<Uint8Array>,
    options: KvPutOptions = {}
  ): Promise<void> {
    let bytes: Uint8Array;
    if (isString(value)) {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = Uint8Array.from(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = Uint8Array.from(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        )
      );
    } else {
      bytes = await streamToBytes(value);
    }
    const { expiration: absolute, expirationTtl, metadata } = options;
    let expiration: number | null = null;
    if (absolute !== undefined) {
      expiration = absolute;
    } else if (expirationTtl !== undefined) {
      if (expirationTtl < 60) {
        throw new Error("KV expirationTtl must be at least 60 seconds");
      }
      expiration = nowSeconds() + expirationTtl;
    }
    this.db
      .prepare(
        "INSERT INTO kv_entries (key, value, metadata, expiration) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expiration = excluded.expiration"
      )
      .run(
        key,
        bytes,
        metadata === undefined ? null : JSON.stringify(metadata),
        expiration
      );
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async KV API; sync faults surface as rejections.
  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv_entries WHERE key = ?").run(key);
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async KV API; sync faults surface as rejections.
  async list(options: KvListOptions = {}): Promise<KvListResult> {
    const prefix = options.prefix ?? "";
    const limit = Math.min(options.limit ?? 1000, 1000);
    const start =
      options.cursor === undefined ? 0 : decodeCursor(options.cursor);
    const rows = this.db
      .prepare(
        "SELECT key, metadata, expiration FROM kv_entries WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
      )
      .all(`${prefix.replaceAll(/[%_\\]/gu, (char) => `\\${char}`)}%`);
    const now = nowSeconds();
    const live: KvKey[] = [];
    const expired: string[] = [];
    for (const row of rows) {
      const expiration =
        row["expiration"] === null ? null : Number(row["expiration"]);
      const name = String(row["key"]);
      if (expiration !== null && expiration <= now) {
        expired.push(name);
        continue;
      }
      const entry: KvKey = { name };
      if (expiration !== null) {
        entry.expiration = expiration;
      }
      if (row["metadata"] !== null) {
        // SAFETY: metadata was serialized by put() via JSON.stringify; parse restores the caller's JSON object.
        entry.metadata = JSON.parse(String(row["metadata"])) as KvMetadata;
      }
      live.push(entry);
    }
    for (const name of expired) {
      this.db.prepare("DELETE FROM kv_entries WHERE key = ?").run(name);
    }
    const page = live.slice(start, start + limit);
    const complete = start + limit >= live.length;
    const result: KvListResult = { keys: page, list_complete: complete };
    if (!complete) {
      result.cursor = encodeCursor(start + limit);
    }
    return result;
  }

  close(): void {
    this.db.close();
  }
}
