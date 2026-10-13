/* oxlint-disable anti-slop/no-known-value-widening -- codec returns envelope literals under the unknown storage-value contract by design. */
// Tag/untag codec for Durable Object storage values: a JSON-safe envelope for
// the values JSON cannot represent (undefined, bytes, Date, Map, Set).
// Buffer and slice copies preserve binary identity across the TEXT column.
import { isRecord, isString } from "../guards.ts";

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- contract: storage values are arbitrary structured-cloneable values by definition.
export const tag = (value: unknown): unknown => {
  if (value === undefined) {
    return { $undef: true };
  }
  if (value instanceof Uint8Array) {
    return { $bin: Buffer.from(value).toString("base64"), $bytes: "u8" };
  }
  if (value instanceof ArrayBuffer) {
    return { $bin: Buffer.from(value).toString("base64"), $bytes: "ab" };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (value instanceof Map) {
    return { $map: [...value].map(([key, entry]) => [tag(key), tag(entry)]) };
  }
  if (value instanceof Set) {
    return { $set: [...value].map(tag) };
  }
  if (Array.isArray(value)) {
    return value.map(tag);
  }
  if (isRecord(value)) {
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: storage objects carry arbitrary nested values.
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = tag(entry);
    }
    return out;
  }
  return value;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- contract: storage reads decode to arbitrary structured-cloneable values by definition.
export const untag = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(untag);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (value["$undef"] === true) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the codec contract decodes $undef to undefined (not missing).
    return undefined;
  }
  if (isString(value["$bin"])) {
    const bytes = Buffer.from(value["$bin"], "base64");
    return value["$bytes"] === "ab"
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
      : new Uint8Array(bytes);
  }
  if (isString(value["$date"])) {
    return new Date(value["$date"]);
  }
  if (Array.isArray(value["$map"])) {
    return new Map(
      // SAFETY: tagged maps encode as [[key, entry], ...] pairs; tag() is the only writer.
      (value["$map"] as unknown[][]).map(([key, entry]) => [
        untag(key),
        untag(entry),
      ])
    );
  }
  if (Array.isArray(value["$set"])) {
    return new Set(
      // SAFETY: tagged sets encode as [...values]; tag() is the only writer.
      (value["$set"] as unknown[]).map(untag)
    );
  }
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: storage objects carry arbitrary nested values.
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = untag(entry);
  }
  return out;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: storage writes accept arbitrary structured-cloneable values.
export const encodeValue = (value: unknown): string =>
  JSON.stringify(tag(value));

// oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: storage reads decode to arbitrary values.
export const decodeValue = (stored: string): unknown =>
  // SAFETY: JSON.parse yields the tagged envelope; untag treats it as an opaque tagged value.
  untag(JSON.parse(stored) as unknown);
