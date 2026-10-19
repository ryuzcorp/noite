import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { connection, resolveSlug, sanitizeSlug } from "./config.js";

/** The environment each test starts from, restored afterwards: the resolution
 * under test reads `process.env`, so a stray NOITE_* on the machine would hide
 * a regression. */
let saved = { ...process.env };

/** Put one of the six fixed names back the way the test found it. */
const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- `key` is one of the six fixed names restored below, one by one.
    delete process.env[key];

    return;
  }

  process.env[key] = value;
};

beforeEach(() => {
  saved = { ...process.env };
  delete process.env.GIT_PUBLIC_BASE;
  delete process.env.NOITE_API_KEY;
  delete process.env.NOITE_APP_URL;
  delete process.env.NOITE_BASE;
  delete process.env.NOITE_GIT_TOKEN;
  delete process.env.NOITE_SLUG;
});

afterEach(() => {
  restore("GIT_PUBLIC_BASE", saved.GIT_PUBLIC_BASE);
  restore("NOITE_API_KEY", saved.NOITE_API_KEY);
  restore("NOITE_APP_URL", saved.NOITE_APP_URL);
  restore("NOITE_BASE", saved.NOITE_BASE);
  restore("NOITE_GIT_TOKEN", saved.NOITE_GIT_TOKEN);
  restore("NOITE_SLUG", saved.NOITE_SLUG);
  saved = {};
});

/** The flags a command parses, with everything unset. */
const flags = (overrides: Partial<Record<string, string>> = {}) => ({
  appUrl: "",
  slug: "",
  token: "",
  url: "",
  ...overrides,
});

describe("resolveSlug", () => {
  test("prefers the flag, then NOITE_SLUG, then the repo name", () => {
    expect(resolveSlug("from-flag", "owner/from-repo")).toBe("from-flag");
    expect(resolveSlug("", "owner/from-repo")).toBe("from-repo");
    process.env.NOITE_SLUG = "From_Env";
    expect(resolveSlug("", "owner/from-repo")).toBe("from-env");
    expect(resolveSlug("", null)).toBe("from-env");
  });

  test("is empty without any of the three", () => {
    expect(resolveSlug("", null)).toBe("");
  });

  test("sanitizes to a slug", () => {
    expect(sanitizeSlug("My_App.v2")).toBe("my-app-v2");
  });
});

describe("connection", () => {
  test("derives the control origin from the git base", async () => {
    const prod = await Effect.runPromise(
      connection(
        flags({ token: "k", url: "https://git.noite.now/" }),
        "owner/my-app"
      )
    );

    expect(prod).toEqual({
      appUrl: "https://app.noite.now",
      gitBase: "https://git.noite.now",
      slug: "my-app",
      token: "k",
    });

    // A localhost install serves control on the bare base domain, not `app.`.
    const dev = await Effect.runPromise(
      connection(
        flags({ token: "k", url: "http://git.noite.localhost:9080" }),
        "owner/my-app"
      )
    );

    expect(dev.appUrl).toBe("http://noite.localhost:9080");
  });

  test("--app-url and NOITE_APP_URL win over the derivation", async () => {
    const explicit = await Effect.runPromise(
      connection(
        flags({
          appUrl: "https://control.example.com/",
          token: "k",
          url: "https://git.noite.now",
        }),
        "owner/my-app"
      )
    );

    expect(explicit.appUrl).toBe("https://control.example.com");
    process.env.NOITE_APP_URL = "http://noite.localhost:9080";

    const fromEnv = await Effect.runPromise(
      connection(
        flags({ token: "k", url: "https://git.noite.now" }),
        "owner/my-app"
      )
    );

    expect(fromEnv.appUrl).toBe("http://noite.localhost:9080");
  });

  test("falls back to NOITE_API_KEY and the dev git base", async () => {
    process.env.NOITE_API_KEY = "env-key";
    const conn = await Effect.runPromise(connection(flags({}), "o/app"));
    expect(conn.token).toBe("env-key");
    expect(conn.gitBase).toBe("http://git.noite.localhost:9080");
  });

  test("refuses a missing slug, a missing key and a malformed base", async () => {
    expect(
      await Effect.runPromise(
        Effect.flip(connection(flags({ token: "k" }), null))
      )
    ).toContain("slug required");
    expect(
      await Effect.runPromise(
        Effect.flip(connection(flags({ url: "not a url" }), "o/app"))
      )
    ).toContain("API key required");
    expect(
      await Effect.runPromise(
        Effect.flip(
          connection(flags({ token: "k", url: "not a url" }), "o/app")
        )
      )
    ).toContain("git base URL is malformed");
  });
});
