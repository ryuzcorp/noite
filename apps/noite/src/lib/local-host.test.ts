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
      "pod-0f4b0f6e-5a8e-4a0e-9c3f-2b1d0c9e8f7a.noite.localhost",
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
