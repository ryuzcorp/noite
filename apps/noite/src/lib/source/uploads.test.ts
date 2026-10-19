import { describe, expect, test } from "bun:test";

import { formatBytes } from "../bytes";
import {
  TEXT_MAX_BYTES,
  UPLOAD_LIMITS,
  checkLimits,
  isTextBytes,
  readPickedFiles,
} from "./uploads";
import type { UploadLimits, UploadRead } from "./uploads";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A binary read standing in for one the runner would write, sized as asked. */
const binary = (path: string, bytes: number): UploadRead => ({
  base64: "",
  bytes,
  kind: "binary",
  path,
});

const text = (path: string, body: string): UploadRead => ({
  kind: "text",
  path,
  text: body,
});

/** The read `checkLimits` must ignore: nothing was read, so nothing is written. */
const unreadable = (path: string): UploadRead => ({
  kind: "error",
  path,
  reason: "Could not be read.",
});

const MIB = 1024 * 1024;

describe("isTextBytes", () => {
  test("accepts ascii", () => {
    expect(isTextBytes(utf8("hello"))).toBe(true);
  });

  test("accepts multibyte utf-8", () => {
    expect(isTextBytes(utf8("héllo — 世界"))).toBe(true);
  });

  test("accepts an empty file", () => {
    expect(isTextBytes(new Uint8Array())).toBe(true);
  });

  test("refuses a NUL byte", () => {
    expect(isTextBytes(utf8("a\u0000b"))).toBe(false);
  });

  test("refuses invalid utf-8", () => {
    expect(isTextBytes(new Uint8Array([0x68, 0xff, 0x69]))).toBe(false);
  });
});

describe("formatBytes", () => {
  test("renders the limits the page states", () => {
    expect(formatBytes(UPLOAD_LIMITS.maxFileBytes)).toBe("10 MB");
    expect(formatBytes(UPLOAD_LIMITS.maxTotalBytes)).toBe("25 MB");
  });
});

describe("readPickedFiles", () => {
  test("reads a text file as text", async () => {
    const reads = await readPickedFiles([new File(["hello"], "note.txt")]);
    expect(reads).toEqual([{ kind: "text", path: "note.txt", text: "hello" }]);
  });

  test("reads a file with a NUL byte as base64", async () => {
    const reads = await readPickedFiles([
      new File([new Uint8Array([0x68, 0x00, 0x69])], "blob.bin"),
    ]);

    expect(reads).toEqual([
      { base64: "aABp", bytes: 3, kind: "binary", path: "blob.bin" },
    ]);
  });

  test("reads invalid utf-8 as base64", async () => {
    const reads = await readPickedFiles([
      new File([new Uint8Array([0xff, 0xfe, 0xfd])], "junk.dat"),
    ]);

    expect(reads).toEqual([
      { base64: "//79", bytes: 3, kind: "binary", path: "junk.dat" },
    ]);
  });

  test("keeps a file at the text cap as text", async () => {
    const reads = await readPickedFiles([
      new File(["a".repeat(TEXT_MAX_BYTES)], "edge.txt"),
    ]);

    expect(reads[0]?.kind).toBe("text");
  });

  test("reads one byte over the text cap as base64", async () => {
    const reads = await readPickedFiles([
      new File(["a".repeat(TEXT_MAX_BYTES + 1)], "over.txt"),
    ]);

    expect(reads[0]?.kind).toBe("binary");
    expect(reads[0]).toMatchObject({ bytes: TEXT_MAX_BYTES + 1 });
  });

  test("keeps the order and paths of several files", async () => {
    const reads = await readPickedFiles([
      new File(["one"], "one.txt"),
      new File([new Uint8Array([0x00])], "two.bin"),
    ]);

    expect(reads.map((read) => read.path)).toEqual(["one.txt", "two.bin"]);
    expect(reads.map((read) => read.kind)).toEqual(["text", "binary"]);
  });
});

describe("checkLimits", () => {
  test("passes an upload that fits", () => {
    expect(
      checkLimits(
        [text("note.txt", "hi"), binary("logo.png", 2048)],
        UPLOAD_LIMITS
      )
    ).toBeNull();
  });

  test("names the file over the per-file cap", () => {
    const big = binary("logo.png", UPLOAD_LIMITS.maxFileBytes + 1);
    expect(checkLimits([big], UPLOAD_LIMITS)).toBe(
      "logo.png is larger than 10 MB."
    );
  });

  test("names the first oversized file on the list", () => {
    const big = UPLOAD_LIMITS.maxFileBytes + 1;
    const reads = [binary("a.bin", big), binary("b.bin", big)];
    expect(checkLimits(reads, UPLOAD_LIMITS)).toBe(
      "a.bin is larger than 10 MB."
    );
  });

  test("flags a commit over the total cap", () => {
    const reads = [
      binary("a.bin", 9 * MIB),
      binary("b.bin", 9 * MIB),
      binary("c.bin", 9 * MIB),
    ];

    expect(checkLimits(reads, UPLOAD_LIMITS)).toBe(
      "The upload is larger than 25 MB in total."
    );
  });

  test("flags a commit over the count cap", () => {
    const reads = Array.from({ length: 101 }, (_, index) =>
      binary(`file-${index}.txt`, 1)
    );

    expect(checkLimits(reads, UPLOAD_LIMITS)).toBe(
      "Up to 100 files per commit."
    );
  });

  test("fits exactly at every cap", () => {
    const reads = [
      binary("a.bin", 10 * MIB),
      binary("b.bin", 10 * MIB),
      binary("c.bin", 5 * MIB),
    ];

    expect(checkLimits(reads, UPLOAD_LIMITS)).toBeNull();
  });

  test("ignores a read that failed", () => {
    const limits: UploadLimits = {
      maxFileBytes: 10,
      maxFiles: 1,
      maxTotalBytes: 10,
    };

    expect(
      checkLimits([unreadable("gone.txt"), text("a.txt", "hi")], limits)
    ).toBeNull();
  });

  test("weighs text as its utf-8 bytes", () => {
    const limits: UploadLimits = {
      maxFileBytes: 4,
      maxFiles: 2,
      maxTotalBytes: 3,
    };

    expect(checkLimits([text("a.txt", "éé")], limits)).toBe(
      "The upload is larger than 3 B in total."
    );
  });

  test("counts text and base64 together", () => {
    const limits: UploadLimits = {
      maxFileBytes: 10,
      maxFiles: 5,
      maxTotalBytes: 8,
    };

    const reads = [text("a.txt", "hello"), binary("b.bin", 4)];
    expect(checkLimits(reads, limits)).toBe(
      "The upload is larger than 8 B in total."
    );
  });
});
