import { describe, expect, test } from "bun:test";

import {
  isPreviewHost,
  previewBase,
  previewHost,
  previewOrigin,
} from "./preview-host";

describe("preview hosts", () => {
  test("a *.localhost dev base stays plain http on the edge's port", () => {
    expect(previewHost("test2", "noite.localhost")).toBe(
      "app-0.preview.test2.noite.localhost"
    );
    expect(previewOrigin("test2", "noite.localhost", "9080")).toBe(
      "http://app-0.preview.test2.noite.localhost:9080"
    );
    // Bare `localhost` is the same dev family: unchanged behavior.
    expect(previewOrigin("test2", "localhost", "9080")).toBe(
      "http://app-0.preview.test2.localhost:9080"
    );
  });

  test("a public base is https without a port", () => {
    expect(previewOrigin("test2", "noite.now")).toBe(
      "https://app-0.preview.test2.noite.now"
    );
  });

  test("a page on a DNS extra control host keeps its preview on that host", () => {
    const extras = "noite.local,192.168.10.97";
    // `https://noite.local` behind a local TLS proxy: https, same site.
    const base = previewBase("noite.local", "noite.localhost", extras);
    expect(base).toBe("noite.local");
    expect(previewOrigin("test", base)).toBe(
      "https://app-0.preview.test.noite.local"
    );
    expect(previewBase("NOITE.LOCAL:9080", "noite.localhost", extras)).toBe(
      "noite.local"
    );
  });

  test("any other page host keeps the configured base", () => {
    const extras = "noite.local, 192.168.10.97 ,lan:9080";
    for (const host of [
      "noite.localhost:9080",
      "192.168.10.97:9080",
      "lan:9080",
      "evil.example",
      "test.noite.local",
    ]) {
      expect(previewBase(host, "noite.localhost", extras)).toBe(
        "noite.localhost"
      );
    }
    expect(previewBase("noite.local", "noite.localhost")).toBe(
      "noite.localhost"
    );
  });

  test("only the preview label names a preview host", () => {
    expect(isPreviewHost("app-0.preview.test2.noite.localhost:9080")).toBe(
      true
    );
    expect(isPreviewHost("noite.localhost:9080")).toBe(false);
    expect(isPreviewHost("test2.noite.localhost")).toBe(false);
    expect(isPreviewHost(null)).toBe(false);
  });
});
