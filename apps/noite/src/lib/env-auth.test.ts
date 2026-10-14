import { describe, expect, test } from "bun:test";

import {
  environmentHost,
  environmentReturnPath,
  envAuthLocation,
  sameOriginPath,
} from "./env-auth";

describe("sameOriginPath", () => {
  test("keeps a rooted path", () => {
    expect(sameOriginPath("/api/env-auth?env=e1&app=a1")).toBe(
      "/api/env-auth?env=e1&app=a1"
    );
  });

  test("refuses a protocol-relative or non-rooted value", () => {
    expect(sameOriginPath("//evil.example/x")).toBeNull();
    expect(sameOriginPath("https://evil.example/x")).toBeNull();
    expect(sameOriginPath("api/apps")).toBeNull();
    expect(sameOriginPath("")).toBeNull();
  });

  test("refuses a backslash (browsers normalize it to /)", () => {
    expect(sameOriginPath("/\\evil.example")).toBeNull();
  });
});

describe("environmentHost", () => {
  test("joins label, slug and base", () => {
    expect(environmentHost("feat-x", "app-one", "noite.now", "")).toBe(
      "feat-x.app-one.noite.now"
    );
  });

  test("keeps the dev port", () => {
    expect(
      environmentHost("feat-x", "app-one", "noite.localhost", "9080")
    ).toBe("feat-x.app-one.noite.localhost:9080");
  });
});

describe("environmentReturnPath", () => {
  const host = "feat-x.app-one.noite.localhost:9080";

  test("keeps the path and query of a URL on the environment's own host", () => {
    expect(
      environmentReturnPath(`http://${host}/checkout/cart?step=2`, host)
    ).toBe("/checkout/cart?step=2");
  });

  test("falls back to / for another host (open-redirect guard)", () => {
    expect(environmentReturnPath("https://evil.example/steal", host)).toBe("/");
    expect(
      environmentReturnPath(`http://${host}.evil.example/steal`, host)
    ).toBe("/");
  });

  test("falls back to / when missing or malformed", () => {
    expect(environmentReturnPath("", host)).toBe("/");
    expect(environmentReturnPath("not a url", host)).toBe("/");
  });
});

describe("envAuthLocation", () => {
  test("encodes the token and the return path", () => {
    expect(
      envAuthLocation(
        "http://feat-x.app-one.noite.localhost:9080",
        "a b",
        "/x?y=1"
      )
    ).toBe(
      "http://feat-x.app-one.noite.localhost:9080/__noite/auth?token=a%20b&return=%2Fx%3Fy%3D1"
    );
  });
});
