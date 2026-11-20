//! Test-run guard: a unit test that installs a browser global must put it
//! back. Every file in one `bun test` run shares the process's global object,
//! so a fixture that restores only the names it remembered to restore leaves
//! a half-faked DOM behind: the next file's SSR render takes the browser
//! branch, `appUrl()` reads `window.location` and throws, and ilha paints its
//! error view instead of the component's tree (a keyed-row assertion then
//! loses the row). That is an order-dependent CI failure, not a test rerun.
//!
//! Loaded from `bunfig.toml` (`[test] preload`). The check runs after every
//! file-level `afterEach`, so a fixture that puts its globals away there is
//! clean. Each test is compared with its own start, so a file-scoped fixture
//! installed in `beforeAll` is baseline, never a leak.

import { afterEach, beforeEach } from "bun:test";

/** Globals a unit test replaces wholesale: the DOM ilha mounts into, the
 * browser stores, the timers a hand-fired clock owns, and the network the
 * feed and the resource readers stub out. */
const WATCHED = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "EventSource",
  "fetch",
  "setTimeout",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "getSelection",
] as const;

/** The watched globals in `now` that were absent from `before`. */
export const leakedGlobals = (
  before: ReadonlySet<string>,
  now: ReadonlySet<string>
): string[] => [...now].filter((name) => !before.has(name));

const present = (): Set<string> =>
  new Set(WATCHED.filter((name) => name in globalThis));

/** The watched globals present when the running test started (its file's
 * `beforeAll` included). */
let before = new Set<string>();

beforeEach(() => {
  before = present();
});

afterEach(() => {
  const leaked = leakedGlobals(before, present());

  if (leaked.length > 0) {
    throw new Error(
      `left browser globals installed: ${leaked.join(", ")} — restore them before the test ends. One \`bun test\` run shares one global object, so a stray \`window\` without \`location\` makes the next file's SSR render throw.`
    );
  }
});
