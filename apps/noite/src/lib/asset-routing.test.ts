/**
 * The two halves of the asset-serving fix, asserted together: the deployed
 * `run_worker_first` list must keep `/assets/*` off the Worker (celld serves
 * the bundle itself), and the action timeout must never bound a static file.
 *
 * Why the pairing matters (the e2e "flake wave"): with worker-first assets,
 * Void's pages fallback serves a chunk from *inside* the Hono app, so the
 * request runs the whole middleware chain and awaits the isolate-level
 * manifest single-flight. celld drops a request's pending work when that
 * request answers or its client leaves (CHANGELOG: "a dropped DB setup pass
 * no longer stalls the whole control plane"), so one aborted request can
 * leave that shared promise unsettled — every later `/assets/*` request in
 * the same isolate then waits on the orphan and our 15 s bound answers a
 * JSON 504. The browser cannot execute a 504, so the island never hydrates
 * and every locator on that page times out 30 s later.
 */
import { describe, expect, test } from "bun:test";

import { RUN_WORKER_FIRST } from "../../void.config.ts";
import { routeTimeout } from "../middleware/01-timeout";

/**
 * celld's `run_worker_first` decision, as `docs/services/static-assets.md`
 * states it: up to 100 route patterns, a `!` prefix excludes, `*` matches any
 * run of characters (a pattern not ending in `*` is exact), and an excluded
 * path never reaches the Worker even when `/**` also matches.
 */
const startsWorker = (path: string): boolean => {
  const matches = (pattern: string): boolean => {
    const body = pattern
      .split("*")
      .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*");

    return new RegExp(
      pattern.endsWith("*") ? `^${body}` : `^${body}$`,
      "u"
    ).test(path);
  };

  const excluded = RUN_WORKER_FIRST.some(
    (rule) => rule.startsWith("!") && matches(rule.slice(1))
  );

  return (
    !excluded &&
    RUN_WORKER_FIRST.some((rule) => !rule.startsWith("!") && matches(rule))
  );
};

describe("control asset routing", () => {
  test("celld answers the bundle without starting the Worker", () => {
    expect(RUN_WORKER_FIRST).toEqual(["/**", "!/assets/*"]);

    for (const path of [
      "/assets/pages-client-CA3vIREc.js",
      "/assets/Data-VKhIgRwp.js",
      "/assets/layout-CirV7yER.css",
      "/assets/geist-latin-wght-normal-BgDaEnEv.woff2",
      // nested names stay inside the rule
      "/assets/chunks/editor.js",
    ]) {
      expect(startsWorker(path)).toBe(false);
      expect(routeTimeout(path)).toEqual({ kind: "exempt", why: "static" });
    }
  });

  test("every other path still starts the Worker", () => {
    // Pages, actions and the pod document must keep the app pipeline: the
    // pod-host gate and the auth middleware only run there.
    for (const path of [
      "/",
      "/apps/new",
      "/apps/a/source",
      "/api/apps/create",
      "/api/streams",
      "/__nodepod_bridge__.html",
      "/__sw__.js",
      "/favicon.svg",
    ]) {
      expect(startsWorker(path)).toBe(true);
    }
  });
});
