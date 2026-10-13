import { describe, expect, test } from "bun:test";

import { isLocalhostDomain } from "./local-host";

describe("isLocalhostDomain", () => {
  test("covers the whole localhost family", () => {
    const missed = [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "noite.localhost",
      " app.noite.localhost ",
      "app-0.preview.test2.noite.localhost",
    ].filter((domain) => !isLocalhostDomain(domain));
    expect(missed).toEqual([]);
  });

  test("leaves real domains to the real-domain rules", () => {
    const wrong = [
      "noite.now",
      "noite.local",
      "notlocalhost",
      "localhost.noite.now",
      "noite.noite",
      "",
    ].filter((domain) => isLocalhostDomain(domain));
    expect(wrong).toEqual([]);
  });
});
