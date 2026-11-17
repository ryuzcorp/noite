import { describe, expect, test } from "bun:test";

import { execGitRedacted, redactGitSecrets } from "./helpers";

describe("redactGitSecrets", () => {
  test("masks userinfo in a failing command line", () => {
    expect(
      redactGitSecrets(
        "Command failed: git ls-remote http://git:s3cret-key@localhost:8080/slug"
      )
    ).toBe("Command failed: git ls-remote http://***@localhost:8080/slug");
  });

  test("masks every occurrence and leaves clean urls alone", () => {
    expect(redactGitSecrets("http://host/a and https://u:p@h/b")).toBe(
      "http://host/a and https://***@h/b"
    );
  });

  test("a failing authenticated command never leaks the key", () => {
    const key = `probe-${Date.now()}`;
    let threw = false;
    let message = "";

    try {
      execGitRedacted(["ls-remote", `http://git:${key}@example.invalid/slug`]);
    } catch (error) {
      threw = true;
      // SAFETY: execGitRedacted only throws Error.
      ({ message } = error as Error);
    }

    expect(threw).toBe(true);
    expect(message).not.toContain(key);
  });
});
