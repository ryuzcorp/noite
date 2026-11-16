/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- test double: a fake window stands in for the browser globals the login panel reads (location + history only, no DOM); globalThis is the only handle to the test's own globals */
import { afterEach, describe, expect, test } from "bun:test";

import { renderHtml } from "ilha/test";

import { LoginPanel } from "./login-panel";

const Probe = () => <LoginPanel />;

const replaced: string[][] = [];

/** The browser globals the invite capture touches: the live query string
 * and history. No DOM: the panel SSR-renders without one. */
const installWindow = (search: string): void => {
  const globals = globalThis as unknown as Record<string, unknown>;

  globals.window = {
    history: {
      pushState: (...args: unknown[]) => {
        replaced.push(["push", ...args.map(String)]);
      },
      replaceState: (...args: unknown[]) => {
        replaced.push(["replace", ...args.map(String)]);
      },
    },
    location: { hash: "", pathname: "/login", search },
  };
};

const removeWindow = (): void => {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals.window;
};

afterEach(() => {
  removeWindow();
  replaced.length = 0;
});

describe("invite link capture", () => {
  test("mount, strip, remount keeps the attached notice", async () => {
    // First mount behind the loading policy, with the link in the URL: the
    // token is captured and stripped (replaceState, no navigation).
    installWindow("?invite=link-token-1");
    const first = await renderHtml(Probe);
    expect(first).toContain("Your invitation from the link is attached");
    expect(
      replaced.some(
        (call) => call[0] === "replace" && !String(call[3]).includes("invite=")
      )
    ).toBe(true);

    // The policy resolves and the Create account tab remounts the form —
    // same module, fresh fibers, URL already stripped. The notice must
    // survive on the captured copy, or the token never reaches the submit.
    installWindow("");
    const second = await renderHtml(Probe);
    expect(second).toContain("Your invitation from the link is attached");
  });
});
