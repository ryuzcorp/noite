import { describe, expect, test } from "bun:test";

import { base64ToBytes, bytesToBase64, formatBytes } from "./bytes";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("bytesToBase64", () => {
  test("encodes ascii", () => {
    expect(bytesToBase64(utf8("hello"))).toBe("aGVsbG8=");
  });

  test("round trips every byte value", () => {
    const all = new Uint8Array(256).map((_, index) => index);
    expect([...base64ToBytes(bytesToBase64(all))]).toEqual([...all]);
  });

  test("chunks a body past one spread", () => {
    const bytes = new Uint8Array(100_000).fill(0x61);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe("formatBytes", () => {
  test("keeps a small count in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  test("steps up through binary units", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
  });

  test("shows one decimal under ten", () => {
    expect(formatBytes(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });

  test("floors a negative count", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});
