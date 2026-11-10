import { describe, expect, test } from "bun:test";

import type { R2Object } from "../../runner";
import { r2BodyOf } from "./body";

const object = (contentType: string | null): R2Object => ({
  contentType,
  etag: null,
  key: "a.txt",
  lastModified: "2026-01-01T00:00:00Z",
  name: "a.txt",
  size: 4,
});

const ready = (contentType: string | null, text: string | null) => ({
  _tag: "Ready" as const,
  value: { contentType, key: "a.txt", size: 4, text, truncated: false },
});

describe("R2 preview body", () => {
  test("a binary body and an empty file are one state", () => {
    expect(r2BodyOf(ready(null, null), object(null)).body._tag).toBe("NotText");
    expect(
      r2BodyOf(ready("text/plain", null), object("text/plain")).body._tag
    ).toBe("NotText");
  });

  test("JSON is detected from either content type", () => {
    expect(
      r2BodyOf(ready("application/json", "{}"), object(null)).body._tag
    ).toBe("Json");
    expect(
      r2BodyOf(ready(null, "{}"), object("application/json")).body._tag
    ).toBe("Json");
  });

  test("a failed reload keeps the last body and surfaces the notice", () => {
    const { body, notice } = r2BodyOf(
      {
        _tag: "Failed",
        error: new Error("offline"),
        value: {
          contentType: "text/plain",
          key: "a.txt",
          size: 4,
          text: "hi",
          truncated: false,
        },
      },
      object("text/plain")
    );

    expect(body._tag).toBe("Text");
    expect(notice).toBe("offline");
  });
});
