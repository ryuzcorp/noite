//! The static half of a preview: an assets directory served out of the pod's
//! filesystem, and the page an unmatched request gets. This is Cloudflare's
//! own order — a file answers first, the Worker answers next, and only a
//! Worker 404 reaches `not_found_handling` — so `fetch` here answers the
//! file, `notFound` the fallback, and the caller decides when to ask for
//! which. Written into the pod as-is, so it imports nothing but `node:fs`.

import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * @typedef {"404-page" | "none" | "single-page-application"} NotFoundHandling
 */

const TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const typeOf = (file) => {
  const dot = file.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  return TYPES[file.slice(dot).toLowerCase()] ?? "application/octet-stream";
};

/** A file's response. Assets are read per request and never cached: a preview
 * watches a build that rewrites them. */
const fileResponse = (path, status) => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  return new Response(readFileSync(path), {
    headers: {
      "cache-control": "no-store",
      "content-type": typeOf(path),
    },
    status,
  });
};

/** `directory` as an assets root, served the way Cloudflare serves one. */
export const createAssets = (options) => {
  const root = options.directory.replace(/\/+$/u, "");
  const handling = options.notFoundHandling ?? "single-page-application";

  /** The pod path a request names, or null when it names the assets root or
   * tries to leave it. */
  const pathOf = (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return null;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return null;
    }
    if (pathname.split("/").includes("..")) {
      return null;
    }
    const relative = pathname.replace(/^\/+/u, "");
    if (relative === "" || relative.endsWith("/")) {
      return `${root}/${relative}index.html`;
    }
    return `${root}/${relative}`;
  };

  return {
    fetch: (request) => {
      const path = pathOf(request);
      if (path === null) {
        return null;
      }
      const found = fileResponse(path, 200);
      if (found !== null) {
        return found;
      }
      // A directory the request named without its trailing slash still holds
      // an index: `/docs` serves `/docs/index.html`.
      if (!path.endsWith("/index.html")) {
        return fileResponse(`${path}/index.html`, 200);
      }
      return null;
    },
    notFound: () => {
      if (handling === "single-page-application") {
        return fileResponse(`${root}/index.html`, 200);
      }
      if (handling === "404-page") {
        return fileResponse(`${root}/404.html`, 404);
      }
      return null;
    },
  };
};
