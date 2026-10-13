import { describe, expect, test } from "bun:test";

import { TEXT_MAX_BYTES } from "../uploads";
import { formatMode, gitBlobSha, hashKey, isBinary } from "./git";

/** `text` as the bytes a file would hold. */
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Git's own ids for these bytes (`git hash-object --stdin`): the workspace
 * and the runner have to agree on them exactly, or every file reads as
 * changed the moment it is pushed. */
const VECTORS: readonly [string, string][] = [
  ["", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
  ["hello\n", "ce013625030ba8dba906f756967f9e9ca394464a"],
  ["hello", "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"],
  ["test content\n", "d670460b4b4aece5915caf5c68d12f560a9fe3e4"],
];

describe("git blob ids", () => {
  for (const [text, sha] of VECTORS) {
    test(`${JSON.stringify(text)} hashes to ${sha}`, async () => {
      expect(await gitBlobSha(bytes(text))).toBe(sha);
    });
  }

  test("bytes that are not text hash the same way", async () => {
    expect(await gitBlobSha(new Uint8Array([0, 1, 2, 255]))).toBe(
      "f971a5e28b6c4cb237ca3c7349e33bb600dbc907"
    );
  });

  test("the length is part of the header, not of the digits", async () => {
    // "blob 0\0" for the empty file, and nothing else: the two must differ.
    expect(await gitBlobSha(new Uint8Array())).not.toBe(
      await gitBlobSha(bytes("0"))
    );
  });
});

describe("hash keys", () => {
  test("a file's key changes with its size or its mtime", () => {
    const key = hashKey("src/main.ts", 12, 1000);
    expect(hashKey("src/main.ts", 12, 1000)).toBe(key);
    expect(hashKey("src/main.ts", 13, 1000)).not.toBe(key);
    expect(hashKey("src/main.ts", 12, 1001)).not.toBe(key);
    expect(hashKey("src/other.ts", 12, 1000)).not.toBe(key);
  });

  test("a path with a NUL-shaped separator cannot collide with another", () => {
    expect(hashKey("a", 1, 2)).not.toBe(hashKey("a\u00001", 2, 0));
  });
});

describe("the text/binary line", () => {
  test("small clean UTF-8 is text", () => {
    expect(isBinary(bytes("hello\n"))).toBe(false);
    expect(isBinary(bytes("héllo — ok\n"))).toBe(false);
  });

  test("a NUL byte makes it binary whatever the extension", () => {
    expect(isBinary(new Uint8Array([104, 0, 105]))).toBe(true);
  });

  test("bytes that are not UTF-8 at all are binary", () => {
    expect(isBinary(new Uint8Array([0xff, 0xfe]))).toBe(true);
  });

  test("a file past the editor's cap travels as bytes", () => {
    expect(isBinary(new Uint8Array(TEXT_MAX_BYTES).fill(97))).toBe(false);
    expect(isBinary(new Uint8Array(TEXT_MAX_BYTES + 1).fill(97))).toBe(true);
  });
});

describe("tar modes as git modes", () => {
  test("the execute bit decides", () => {
    expect(formatMode(0o644)).toBe("100644");
    expect(formatMode(0o755)).toBe("100755");
    expect(formatMode(0o777)).toBe("100755");
    // The mode a tar header carries is the whole file mode, not just its
    // permissions: 0o100644.
    expect(formatMode(0o10_0644)).toBe("100644");
  });
});
