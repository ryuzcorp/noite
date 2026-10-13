import { describe, expect, test } from "bun:test";

import { previewAddress } from "./address";

const BASE = "http://app-0.preview.test.localhost:9080/";

describe("the preview address bar", () => {
  test("a path or a full URL on the preview's origin is followed", () => {
    expect(previewAddress("/api/count?x=1", BASE)).toBe(
      "http://app-0.preview.test.localhost:9080/api/count?x=1"
    );
    expect(
      previewAddress("http://app-0.preview.test.localhost:9080/a#b", BASE)
    ).toBe("http://app-0.preview.test.localhost:9080/a#b");
  });

  test("anything off the preview's origin is refused", () => {
    for (const input of [
      "http://localhost:9080/apps",
      "https://app-0.preview.test.localhost:9080/",
      "http://app-0.preview.test.localhost:9081/",
      "http://app-0.preview.other.localhost:9080/",
      "//evil.example/",
      // oxlint-disable-next-line eslint/no-script-url -- the input the guard must refuse
      "javascript:alert(1)",
      "",
    ]) {
      expect(previewAddress(input, BASE)).toBeNull();
    }
  });

  test("nothing is followed before a preview runs", () => {
    expect(previewAddress("/", "")).toBeNull();
  });
});
