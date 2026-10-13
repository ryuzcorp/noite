//! Git plumbing with no filesystem in it: the blob id of a file's bytes, the
//! key that says whether those bytes need hashing again, the text/binary
//! decision the push payload is built on, and how a tar mode becomes the mode
//! a tree entry carries. Everything here is pure, so the tests pin the parts
//! that must agree with the runner byte for byte.

import { isTextBytes, TEXT_MAX_BYTES } from "../uploads";
import type { GitMode } from "./types";

/** A digest as lowercase hex — the shape a git blob id travels in. */
const hex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

/** The one encoder, so a header and the file body measure bytes the same way. */
const ENCODER = new TextEncoder();

/** A file's git blob id: `sha1("blob <bytes>\0" + bytes)`, hex. It is the only
 * identity the base index, the object cache and the push payload agree on, and
 * the reason a file's bytes can be recognized after they moved. */
export const gitBlobSha = async (bytes: Uint8Array): Promise<string> => {
  const header = ENCODER.encode(`blob ${bytes.byteLength}\u0000`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header);
  framed.set(bytes, header.byteLength);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", framed)));
};

/** What a cached blob id was computed from: a file whose size and mtime both
 * stand still has not been written since. */
export const hashKey = (path: string, size: number, mtime: number): string =>
  `${path}\u0000${size}\u0000${mtime}`;

/** Whether the file travels as base64: too big to be diffed in a panel, or
 * not text at all (invalid UTF-8, or a NUL byte wherever it sits). Mirrors the
 * upload reader's rule, so a file dropped in by hand and one written by the
 * editor are classified the same. */
export const isBinary = (bytes: Uint8Array): boolean =>
  bytes.byteLength > TEXT_MAX_BYTES || !isTextBytes(bytes);

/** The mode string a tree entry carries, from a tar header's octal mode: any
 * execute bit makes it a `100755`. Symlinks are not decided here — they come
 * from the header's type flag, which the tar reader reads. */
export const formatMode = (mode: number): GitMode => {
  const permissions = mode.toString(8).slice(-3);
  const executes = [...permissions].some(
    (digit) => Number.parseInt(digit, 8) % 2 === 1
  );
  return executes ? "100755" : "100644";
};
