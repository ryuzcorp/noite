import { describe, expect, test } from "bun:test";

import {
  isPreviewHost,
  previewBase,
  previewHost,
  previewOrigin,
} from "./preview-host";

/** A fixed app id: the pod host is `pod-<id>`, so tests need a real shape. */
const APP = "0f4b0f6e-5a8e-4a0e-9c3f-2b1d0c9e8f7a";

describe("preview hosts", () => {
  test("a *.localhost dev base stays plain http on the edge's port", () => {
    expect(previewHost(APP, "noite.localhost")).toBe(
      `pod-${APP}.noite.localhost`
    );
    expect(previewOrigin(APP, "noite.localhost", "9080")).toBe(
      `http://pod-${APP}.noite.localhost:9080`
    );
    // Bare `localhost` is the same dev family: unchanged behavior.
    expect(previewOrigin(APP, "localhost", "9080")).toBe(
      `http://pod-${APP}.localhost:9080`
    );
  });

  test("a public base is https without a port", () => {
    expect(previewOrigin(APP, "noite.now")).toBe(
      `https://pod-${APP}.noite.now`
    );
  });

  test("a page on a DNS extra control host keeps its preview on that host", () => {
    const extras = "noite.local,192.168.10.97";
    // `https://noite.local` behind a local TLS proxy: https, same site.
    const base = previewBase("noite.local", "noite.localhost", extras);
    expect(base).toBe("noite.local");
    expect(previewOrigin(APP, base)).toBe(`https://pod-${APP}.noite.local`);
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

  test("only the pod label names a preview host", () => {
    expect(isPreviewHost(`pod-${APP}.noite.localhost:9080`)).toBe(true);
    expect(isPreviewHost(`pod-${APP}.noite.now`)).toBe(true);
    expect(isPreviewHost("noite.localhost:9080")).toBe(false);
    expect(isPreviewHost("pod-not-a-uuid.noite.now")).toBe(false);
    expect(isPreviewHost("test2.noite.localhost")).toBe(false);
    expect(isPreviewHost(null)).toBe(false);
  });
});
