//! Every `/api/...` URL the browser (or a server action) builds must have a
//! route file under `src/routes/api` (Void file routing, `[param]` segments).
//! Release images build from a git checkout, so a git-ignored route passes
//! the local lanes and 404s in prod — alpha.6 shipped without the deployment
//! logs stream that way. This test fails when a feed URL (or any other
//! client-requested path) has no route file.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  applistUrl,
  deploysUrl,
  errorsUrl,
  eventsUrl,
  logsUrl,
  metricsUrl,
} from "./feeds";

const SRC = path.join(import.meta.dir, "..");
const ROUTES_API = path.join(SRC, "routes", "api");

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** A `[param]` segment directory at `dir`, if one exists. */
const paramChild = (dir: string): string | null => {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }

  return (
    names.find(
      (name) =>
        name.startsWith("[") &&
        !name.startsWith("[...") &&
        isDir(path.join(dir, name))
    ) ?? null
  );
};

/** A `[...rest].ts` catch-all file at `dir`, if one exists: it swallows the
 * current segment and everything after it. */
const catchAll = (dir: string): string | null => {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }

  const rest = names.find(
    (name) => name.startsWith("[...") && isFile(path.join(dir, name))
  );

  return rest === undefined ? null : path.join(dir, rest);
};

/** Resolve a client `/api/...` path to its route file (query stripped).
 * Returns the file, or null when no route file serves the path. */
const resolveRoute = (url: string): string | null => {
  const query = url.split("?");
  const segments = (query[0] ?? "").split("/").filter((part) => part !== "");

  if (segments[0] !== "api") {
    return null;
  }

  let dir = ROUTES_API;

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    const last = i === segments.length - 1;

    if (!last && isDir(path.join(dir, segment))) {
      dir = path.join(dir, segment);
      continue;
    }

    if (last && isFile(path.join(dir, `${segment}.ts`))) {
      return path.join(dir, `${segment}.ts`);
    }

    const rest = catchAll(dir);

    if (rest !== null) {
      return rest;
    }

    const child = paramChild(dir);

    if (child === null || last) {
      // A dynamic directory is never a route by itself: feed URLs always end
      // in a file (`.../stream`), so landing here means a missing route.
      return null;
    }

    dir = path.join(dir, child);
  }

  return null;
};

/** Normalize a scanned template to a concrete URL: one dynamic segment per
 * `${...}` (the source-endpoint template expands to both union members). */
const expandScanned = (url: string): string[] => {
  // oxlint-disable-next-line eslint/no-template-curly-in-string -- substring check for the one client template with a finite expansion, not an interpolation
  if (url.includes("${endpoint}")) {
    // Source-commit endpoints (`SourceCommitInput`'s union in
    // commit-source.ts): the client interpolates the endpoint, so expand the
    // template by hand.
    return ["commit", "preview"].map(
      (endpoint) => `/api/apps/app_1/source/${endpoint}`
    );
  }

  return [
    (url.split("?")[0] ?? "")
      .split("/")
      .map((segment) => (segment.includes("${") ? "segment" : segment))
      .join("/"),
  ];
};

/** Every `/api/...` string or template literal under `src`, except
 * `*.test.*` (they build intentionally-failing requests) and `src/testing/`
 * (fixtures for those tests). Doc placeholders (`{id}`, no `$`) are skipped;
 * real `${...}` interpolations resolve as dynamic segments. */
const scanClientUrls = (): string[] => {
  const found = new Set<string>();

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name);

      if (isDir(entry)) {
        if (name !== "testing") {
          walk(entry);
        }

        continue;
      }

      const source =
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".test.tsx");

      if (!source) {
        continue;
      }

      const text = readFileSync(entry, "utf-8");
      const pattern = /["'`](?<url>\/api\/[^"'`\s]*)["'`]/gu;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        const url = match.groups?.url ?? "";

        // Doc placeholder (`/api/apps/{id}/...`), not a built URL.
        if (/\{(?!\$)/u.test(url.replaceAll(/\$\{[^}]*\}/gu, ""))) {
          continue;
        }

        found.add(url);
      }
    }
  };

  walk(SRC);

  return [...found];
};

describe("api routes exist", () => {
  test("every feed URL has a route file", () => {
    // Every builder, every variant, with representative args.
    const urls = [
      applistUrl(),
      deploysUrl("app_1"),
      deploysUrl("app_1", "env_1"),
      deploysUrl("app with/spaces"),
      errorsUrl("app_1", "open"),
      errorsUrl("app_1", "resolved"),
      errorsUrl("app_1", "ignored"),
      logsUrl("app_1"),
      logsUrl("app_1", "env_1"),
      metricsUrl("app_1", 24),
      metricsUrl("app_1", 168),
      metricsUrl("app_1", 720),
      eventsUrl("app_1", "deploys", 50),
      eventsUrl("app_1", "", 20),
    ];

    const missing = urls.filter((url) => resolveRoute(url) === null);

    expect(missing).toEqual([]);
  });

  test("every feed URL builder is covered above", () => {
    // A new builder without a sample URL here would dodge the guard, so the
    // guard reads its own source: every `*Url` export of feeds.ts must be
    // called in this file.
    const feeds = readFileSync(path.join(SRC, "lib", "feeds.ts"), "utf-8");

    const builders = [
      ...feeds.matchAll(/export const (?<builder>\w+Url)\b/gu),
    ].map((match) => match.groups?.builder ?? "");

    const here = readFileSync(import.meta.path, "utf-8");

    const uncovered = builders.filter(
      (builder) => !here.includes(`${builder}(`)
    );

    expect(uncovered).toEqual([]);
  });

  test("every other client-requested path has a route file", () => {
    const missing = new Set<string>();

    for (const url of scanClientUrls()) {
      for (const expanded of expandScanned(url)) {
        if (resolveRoute(expanded) === null) {
          missing.add(url);
        }
      }
    }

    expect([...missing]).toEqual([]);
  });
});
