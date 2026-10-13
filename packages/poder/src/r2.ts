/* eslint-disable max-classes-per-file -- object, upload and bucket are one cohesive R2 adapter */
// R2-compatible bucket over the filesystem: object bytes at
// `<stateDir>/r2/<bucket>/<key…>` plus a JSON sidecar per object. Keys are
// encoded per segment so no key can escape the bucket directory.
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isString } from "./guards.ts";

export interface R2HttpMetadata {
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentType?: string;
  expires?: string;
}

export interface R2Range {
  length?: number;
  offset?: number;
  suffix?: number;
}

export interface R2Conditional {
  etagDoesNotMatch?: string | string[];
  etagMatches?: string | string[];
  uploadedAfter?: Date;
  uploadedBefore?: Date;
}

export interface R2PutOptions {
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HttpMetadata;
  md5?: string | ArrayBuffer | ArrayBufferView;
  onlyIf?: R2Conditional;
  sha1?: string | ArrayBuffer | ArrayBufferView;
  sha256?: string | ArrayBuffer | ArrayBufferView;
  sha512?: string | ArrayBuffer | ArrayBufferView;
}

export interface R2GetOptions {
  onlyIf?: R2Conditional;
  range?: R2Range;
}

export interface R2ListOptions {
  cursor?: string;
  delimiter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
  limit?: number;
  prefix?: string;
}

export interface R2Checksums {
  md5?: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
}

interface R2Sidecar {
  checksums: R2Checksums;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- R2 custom metadata is caller-defined string pairs.
  customMetadata: Record<string, string>;
  etag: string;
  httpMetadata: R2HttpMetadata;
  size: number;
  uploaded: string;
  version: string;
}

const SIDECAR_SUFFIX = ".poder.json";
const UPLOAD_DIR = ".uploads";

const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replaceAll(/%(?:2F|5C)/giu, (match) =>
    match.toUpperCase()
  );

const keyPath = (bucketDir: string, key: string) => {
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === ".") {
      throw new Error(`R2 key escapes its bucket: ${key}`);
    }
  }
  const data = path.join(bucketDir, ...segments.map(encodeSegment));
  return { data, sidecar: `${data}${SIDECAR_SUFFIX}` };
};

const md5Hex = (bytes: Uint8Array): string =>
  createHash("md5").update(bytes).digest("hex");

const hashHex = (bytes: Uint8Array, algorithm: string): string =>
  createHash(algorithm).update(bytes).digest("hex");

const checksumToHex = (
  value: string | ArrayBuffer | ArrayBufferView
): string => {
  if (isString(value)) {
    const compact = value.replaceAll(/[^0-9a-fA-F]/gu, "").toLowerCase();
    if (/^[0-9a-f]+$/u.test(compact) && compact.length > 0) {
      return compact;
    }
    return Buffer.from(value, "base64").toString("hex");
  }
  const view = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return Buffer.from(view).toString("hex");
};
const isReadableStream = (
  value: unknown
): value is ReadableStream<Uint8Array> => {
  if (typeof value !== "object" || value === null || !("getReader" in value)) {
    return false;
  }
  return typeof value.getReader === "function";
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: R2 put takes arbitrary body types.
const readBody = async (value: unknown): Promise<Uint8Array> => {
  if (value === null || value === undefined) {
    return new Uint8Array(0);
  }
  if (isString(value)) {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Uint8Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (isReadableStream(value)) {
    const reader = value.getReader();
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
  }
  throw new Error(
    "R2 put() value must be a string, buffer, Blob, stream, or null"
  );
};

const etagList = (value: string | string[] | undefined): string[] | null => {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? value : [value];
};

const checkPreconditions = (
  sidecar: R2Sidecar | null,
  onlyIf: R2Conditional | undefined
): boolean => {
  if (onlyIf === undefined || sidecar === null) {
    return true;
  }
  const matches = etagList(onlyIf.etagMatches);
  if (matches !== null && !matches.includes(sidecar.etag)) {
    return false;
  }
  const mismatches = etagList(onlyIf.etagDoesNotMatch);
  if (mismatches !== null && mismatches.includes(sidecar.etag)) {
    return false;
  }
  const uploaded = new Date(sidecar.uploaded).getTime();
  if (
    onlyIf.uploadedBefore !== undefined &&
    !(uploaded < onlyIf.uploadedBefore.getTime())
  ) {
    return false;
  }
  if (
    onlyIf.uploadedAfter !== undefined &&
    !(uploaded > onlyIf.uploadedAfter.getTime())
  ) {
    return false;
  }
  return true;
};

const applyRange = (
  bytes: Uint8Array,
  range: R2Range | undefined
): Uint8Array => {
  if (range === undefined) {
    return bytes;
  }
  if (range.suffix !== undefined) {
    if (range.offset !== undefined || range.length !== undefined) {
      throw new Error("R2 range cannot combine suffix with offset/length");
    }
    return bytes.slice(Math.max(0, bytes.length - range.suffix));
  }
  const offset = range.offset ?? 0;
  const end = range.length === undefined ? bytes.length : offset + range.length;
  return bytes.slice(offset, Math.min(end, bytes.length));
};

export class PoderR2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly checksums: R2Checksums;
  readonly httpMetadata: R2HttpMetadata;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- R2 custom metadata is caller-defined string pairs.
  readonly customMetadata: Record<string, string>;
  readonly bodyUsed = false;
  private readonly bytes: Uint8Array | null;

  constructor(key: string, sidecar: R2Sidecar, bytes: Uint8Array | null) {
    this.key = key;
    this.version = sidecar.version;
    this.size = sidecar.size;
    this.etag = sidecar.etag;
    this.uploaded = new Date(sidecar.uploaded);
    this.checksums = sidecar.checksums;
    this.httpMetadata = sidecar.httpMetadata;
    this.customMetadata = sidecar.customMetadata;
    this.bytes = bytes;
  }

  get body(): ReadableStream<Uint8Array> | null {
    const { bytes } = this;
    if (bytes === null) {
      return null;
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  arrayBuffer = async (): Promise<ArrayBuffer> => {
    if (this.bytes === null) {
      throw new Error("No body for this conditional R2 response");
    }
    // SAFETY: Uint8Array.from allocates an exact-size copy, so .buffer is that copy's ArrayBuffer.
    return Uint8Array.from(this.bytes).buffer as ArrayBuffer;
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  text = async (): Promise<string> => {
    if (this.bytes === null) {
      throw new Error("No body for this conditional R2 response");
    }
    return new TextDecoder().decode(this.bytes);
  };

  // SAFETY: the caller names the expected JSON shape via T; untrusted JSON is decoded, not trusted.
  json = async <T = unknown>(): Promise<T> =>
    JSON.parse(await this.text()) as T;

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  blob = async (): Promise<Blob> => {
    if (this.bytes === null) {
      throw new Error("No body for this conditional R2 response");
    }
    // SAFETY: exact-size copy as in arrayBuffer; BlobPart accepts the ArrayBuffer.
    return new Blob([Uint8Array.from(this.bytes).buffer as ArrayBuffer]);
  };

  writeHttpMetadata = (headers: Headers): void => {
    const meta = this.httpMetadata;
    if (meta.contentType !== undefined) {
      headers.set("content-type", meta.contentType);
    }
    if (meta.contentLanguage !== undefined) {
      headers.set("content-language", meta.contentLanguage);
    }
    if (meta.contentDisposition !== undefined) {
      headers.set("content-disposition", meta.contentDisposition);
    }
    if (meta.contentEncoding !== undefined) {
      headers.set("content-encoding", meta.contentEncoding);
    }
    if (meta.cacheControl !== undefined) {
      headers.set("cache-control", meta.cacheControl);
    }
    if (meta.expires !== undefined) {
      headers.set("expires", meta.expires);
    }
    headers.set("etag", this.etag);
  };
}

export interface R2ListResult {
  delimitedPrefixes: string[];
  objects: PoderR2Object[];
  truncated: boolean;
  cursor?: string;
}

export class PoderMultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  private readonly partsDir: string;
  private completeFn:
    | ((parts: { partNumber: number }[]) => Promise<PoderR2Object>)
    | null = null;
  private abortFn: (() => Promise<void>) | null = null;

  constructor(key: string, uploadId: string, bucketDir: string) {
    this.key = key;
    this.uploadId = uploadId;
    this.partsDir = path.join(bucketDir, UPLOAD_DIR, uploadId);
  }

  bind = (
    complete: (parts: { partNumber: number }[]) => Promise<PoderR2Object>,
    abort: () => Promise<void>
  ): void => {
    this.completeFn = complete;
    this.abortFn = abort;
  };

  uploadPart = async (
    partNumber: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: R2 part bodies take arbitrary body types.
    value: unknown
  ): Promise<{ etag: string }> => {
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > 10_000
    ) {
      throw new Error(`Invalid R2 part number: ${partNumber}`);
    }
    const bytes = await readBody(value);
    mkdirSync(this.partsDir, { recursive: true });
    writeFileSync(path.join(this.partsDir, `part-${partNumber}`), bytes);
    writeFileSync(
      path.join(this.partsDir, "key.json"),
      JSON.stringify({ key: this.key })
    );
    return { etag: md5Hex(bytes) };
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  complete = async (
    parts: { partNumber: number }[]
  ): Promise<PoderR2Object> => {
    if (this.completeFn === null) {
      throw new Error("Multipart upload is not bound to a bucket");
    }
    return this.completeFn(parts);
  };

  abort = async (): Promise<void> => {
    if (this.abortFn === null) {
      throw new Error("Multipart upload is not bound to a bucket");
    }
    await this.abortFn();
  };
}

const readSidecar = (sidecarPath: string): R2Sidecar | null => {
  try {
    // SAFETY: sidecars are written by put(); a corrupt sidecar reads as missing and the object is skipped.
    return JSON.parse(readFileSync(sidecarPath, "utf-8")) as R2Sidecar;
  } catch {
    return null;
  }
};

export class PoderR2 {
  private readonly bucketDir: string;

  constructor(bucketDir: string) {
    this.bucketDir = bucketDir;
    mkdirSync(bucketDir, { recursive: true });
  }

  private stored = (
    key: string
  ): { sidecar: R2Sidecar; bytes: Uint8Array } | null => {
    const { data, sidecar } = keyPath(this.bucketDir, key);
    const meta = readSidecar(sidecar);
    if (meta === null || !existsSync(data)) {
      return null;
    }
    return { bytes: readFileSync(data), sidecar: meta };
  };

  put = async (
    key: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: R2 put takes arbitrary body types.
    value: unknown,
    options: R2PutOptions = {}
  ): Promise<PoderR2Object> => {
    const { data, sidecar } = keyPath(this.bucketDir, key);
    const current = readSidecar(sidecar);
    if (
      options.onlyIf !== undefined &&
      !checkPreconditions(current, options.onlyIf)
    ) {
      throw new Error(`R2 put() precondition failed for key: ${key}`);
    }
    const bytes = await readBody(value);
    const checks: [
      algorithm: string,
      expected: string | ArrayBuffer | ArrayBufferView | undefined,
    ][] = [
      ["md5", options.md5],
      ["sha1", options.sha1],
      ["sha256", options.sha256],
      ["sha512", options.sha512],
    ];
    for (const [algorithm, expected] of checks) {
      if (expected === undefined) {
        continue;
      }
      const seen = hashHex(bytes, algorithm);
      if (seen !== checksumToHex(expected)) {
        throw new Error(
          `R2 put() ${algorithm} checksum mismatch for key: ${key}`
        );
      }
    }
    const meta: R2Sidecar = {
      checksums: {
        md5: hashHex(bytes, "md5"),
        sha1: hashHex(bytes, "sha1"),
        sha256: hashHex(bytes, "sha256"),
        sha512: hashHex(bytes, "sha512"),
      },
      customMetadata: options.customMetadata ?? {},
      etag: md5Hex(bytes),
      httpMetadata: options.httpMetadata ?? {},
      size: bytes.length,
      uploaded: new Date().toISOString(),
      version: randomUUID(),
    };
    mkdirSync(path.dirname(data), { recursive: true });
    const tmp = `${data}.tmp-${randomUUID()}`;
    writeFileSync(tmp, bytes);
    writeFileSync(`${tmp}${SIDECAR_SUFFIX}`, JSON.stringify(meta));
    renameSync(tmp, data);
    renameSync(`${tmp}${SIDECAR_SUFFIX}`, sidecar);
    return new PoderR2Object(key, meta, bytes);
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  get = async (
    key: string,
    options: R2GetOptions = {}
  ): Promise<PoderR2Object | null> => {
    const found = this.stored(key);
    if (found === null) {
      return null;
    }
    const { bytes, sidecar } = found;
    if (
      options.onlyIf !== undefined &&
      !checkPreconditions(sidecar, options.onlyIf)
    ) {
      return new PoderR2Object(key, sidecar, null);
    }
    return new PoderR2Object(key, sidecar, applyRange(bytes, options.range));
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  head = async (key: string): Promise<PoderR2Object | null> => {
    const found = this.stored(key);
    if (found === null) {
      return null;
    }
    return new PoderR2Object(key, found.sidecar, null);
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  delete = async (keys: string | string[]): Promise<void> => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const { data, sidecar } = keyPath(this.bucketDir, key);
      rmSync(data, { force: true });
      rmSync(sidecar, { force: true });
    }
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  list = async (options: R2ListOptions = {}): Promise<R2ListResult> => {
    const prefix = options.prefix ?? "";
    const limit = Math.min(options.limit ?? 1000, 1000);
    const start =
      options.cursor === undefined
        ? 0
        : Number(Buffer.from(options.cursor, "base64").toString("utf-8"));
    if (!Number.isInteger(start) || start < 0) {
      throw new Error("Invalid R2 list cursor");
    }
    const keys = this.walkKeys()
      .filter((key) => key.startsWith(prefix))
      .toSorted();
    const objects: PoderR2Object[] = [];
    const prefixes = new Set<string>();
    for (const key of keys) {
      if (options.delimiter !== undefined) {
        const rest = key.slice(prefix.length);
        const at = rest.indexOf(options.delimiter);
        if (at !== -1) {
          prefixes.add(prefix + rest.slice(0, at + options.delimiter.length));
          continue;
        }
      }
      const found = this.stored(key);
      if (found !== null) {
        objects.push(new PoderR2Object(key, found.sidecar, null));
      }
    }
    const page = objects.slice(start, start + limit);
    const truncated = start + limit < objects.length;
    const result: R2ListResult = {
      delimitedPrefixes: [...prefixes].toSorted(),
      objects: page,
      truncated,
    };
    if (truncated) {
      result.cursor = Buffer.from(String(start + limit), "utf-8").toString(
        "base64"
      );
    }
    return result;
  };

  private walkKeys = (): string[] => {
    const keys: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === UPLOAD_DIR && dir === this.bucketDir) {
          continue;
        }
        if (entry.endsWith(SIDECAR_SUFFIX) || entry.includes(".tmp-")) {
          continue;
        }
        const full = path.join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else {
            const rel = path.relative(this.bucketDir, full);
            keys.push(
              rel
                .split(path.sep)
                .map((segment) => decodeURIComponent(segment))
                .join("/")
            );
          }
        } catch {
          continue;
        }
      }
    };
    walk(this.bucketDir);
    return keys;
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  createMultipartUpload = async (
    key: string
  ): Promise<PoderMultipartUpload> => {
    const uploadId = randomUUID();
    const upload = new PoderMultipartUpload(key, uploadId, this.bucketDir);
    mkdirSync(path.join(this.bucketDir, UPLOAD_DIR, uploadId), {
      recursive: true,
    });
    writeFileSync(
      path.join(this.bucketDir, UPLOAD_DIR, uploadId, "key.json"),
      JSON.stringify({ key })
    );
    upload.bind(
      (parts: { partNumber: number }[]) =>
        this.completeMultipartUpload(key, uploadId, parts),
      () => this.abortMultipartUpload(uploadId)
    );
    return upload;
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  resumeMultipartUpload = async (
    key: string,
    uploadId: string
  ): Promise<PoderMultipartUpload> => {
    const dir = path.join(this.bucketDir, UPLOAD_DIR, uploadId);
    let storedKey: string | null = null;
    try {
      // SAFETY: key.json is written by createMultipartUpload; a corrupt upload reads as unknown.
      storedKey = (
        JSON.parse(readFileSync(path.join(dir, "key.json"), "utf-8")) as {
          key: string;
        }
      ).key;
    } catch {
      storedKey = null;
    }
    if (storedKey === null || storedKey !== key) {
      throw new Error(`Unknown R2 upload: ${uploadId}`);
    }
    const upload = new PoderMultipartUpload(key, uploadId, this.bucketDir);
    upload.bind(
      (parts: { partNumber: number }[]) =>
        this.completeMultipartUpload(key, uploadId, parts),
      () => this.abortMultipartUpload(uploadId)
    );
    return upload;
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  completeMultipartUpload = async (
    key: string,
    uploadId: string,
    parts: { partNumber: number }[]
  ): Promise<PoderR2Object> => {
    const dir = path.join(this.bucketDir, UPLOAD_DIR, uploadId);
    const chunks: Uint8Array[] = [];
    for (const part of parts.toSorted((a, b) => a.partNumber - b.partNumber)) {
      try {
        chunks.push(readFileSync(path.join(dir, `part-${part.partNumber}`)));
      } catch {
        throw new Error(
          `Missing R2 part ${part.partNumber} for upload ${uploadId}`
        );
      }
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    rmSync(dir, { force: true, recursive: true });
    return this.put(key, bytes);
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async R2 API; sync faults surface as rejections.
  abortMultipartUpload = async (uploadId: string): Promise<void> => {
    rmSync(path.join(this.bucketDir, UPLOAD_DIR, uploadId), {
      force: true,
      recursive: true,
    });
  };
}
