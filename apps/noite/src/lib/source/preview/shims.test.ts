//! What the preview's remaining shim does with the surface a Worker actually
//! uses. Poder serves D1, KV, R2 and Durable Objects now; the assets shim is
//! the only one left, serving the checkout's static directory with
//! Cloudflare's fallback order.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAssets } from "./shims/assets.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "noite-preview-shims-"));
afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

describe("assets shim", () => {
  const root = path.join(scratch, "site");
  const write = (rel: string, text: string): void => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  test("files, index and the SPA fallback", async () => {
    write("index.html", "<h1>index</h1>");
    write("assets/app.js", "console.log(1);");
    const assets = createAssets({ directory: root });
    const index = assets.fetch(new Request("http://preview.local/"));
    expect(index?.status).toBe(200);
    expect(index?.headers.get("content-type")).toContain("text/html");
    expect(await index?.text()).toBe("<h1>index</h1>");
    const script = assets.fetch(
      new Request("http://preview.local/assets/app.js")
    );
    expect(script?.headers.get("content-type")).toContain("javascript");
    expect(
      assets.fetch(new Request("http://preview.local/deep/route"))
    ).toBeNull();
    const fallback = assets.notFound();
    expect(await fallback?.text()).toBe("<h1>index</h1>");
  });

  test("404-page handling, traversal refusal and non-GET requests", async () => {
    write("index.html", "<h1>index</h1>");
    write("404.html", "<h1>missing</h1>");
    const assets = createAssets({
      directory: root,
      notFoundHandling: "404-page",
    });
    const page = assets.notFound();
    expect(await page?.text()).toBe("<h1>missing</h1>");
    expect(page?.status).toBe(404);
    expect(
      assets.fetch(new Request("http://preview.local/../secrets.txt"))
    ).toBeNull();
    expect(
      assets.fetch(
        new Request("http://preview.local/index.html", { method: "POST" })
      )
    ).toBeNull();
    const none = createAssets({ directory: root, notFoundHandling: "none" });
    expect(none.notFound()).toBeNull();
  });
});
