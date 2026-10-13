//! Byte helpers shared by the source tree, its workspace and the storage
//! views: a byte count as a person reads it, and standard base64 both ways.

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** A byte count as a person reads it (`12 KB`, `1.4 MB`): binary units, one
 * decimal while the number is under ten, none above it. */
export const formatBytes = (bytes: number): string => {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit > 0 && value < 10 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
};

/** How many bytes one spread hands `String.fromCodePoint`: base64 needs the
 * whole file as a binary string, and spreading all of a large file at once
 * blows the argument limit. */
const BASE64_CHUNK = 32_768;

/** `bytes` as standard base64 — the encoding the runner's file items carry,
 * and the reason a binary upload survives the trip as text. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let start = 0; start < bytes.byteLength; start += BASE64_CHUNK) {
    binary += String.fromCodePoint(
      ...bytes.subarray(start, start + BASE64_CHUNK)
    );
  }
  return btoa(binary);
};

/** The bytes `base64` spells: the runner decodes uploads this way, and the
 * pod writes them back as files. */
export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.codePointAt(at) ?? 0;
  }
  return bytes;
};
