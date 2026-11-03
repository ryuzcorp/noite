import { describe, expect, test } from "bun:test";

import { checkCelldPin, parseCelldTag } from "./check-versions-lib";

describe("parseCelldTag", () => {
  test("a fork tag parses into version, flavor and level", () => {
    expect(parseCelldTag("0.6.3-ryuzcorp.4")).toEqual({
      flavor: "ryuzcorp",
      level: 4,
      version: "0.6.3",
    });
  });

  test("a legacy pre-fork tag parses with the noite flavor", () => {
    expect(parseCelldTag("0.6.3-noite.3")).toEqual({
      flavor: "noite",
      level: 3,
      version: "0.6.3",
    });
  });

  test("anything else is malformed", () => {
    for (const tag of [
      "",
      "0.6.3",
      "0.6.3-ryuzcorp",
      "0.6.3-noite",
      "0.6.3-other.1",
      "0.6-ryuzcorp.1",
      "v0.6.3-ryuzcorp.1",
      "0.6.3-ryuzcorp.4 ",
    ]) {
      expect(parseCelldTag(tag)).toBeNull();
    }
  });
});

describe("checkCelldPin", () => {
  test("a fork tag passes, release or not", () => {
    expect(checkCelldPin("0.6.3-ryuzcorp.4", false)).toEqual({
      errors: [],
      notes: [],
    });
    expect(checkCelldPin("0.6.3-ryuzcorp.4", true)).toEqual({
      errors: [],
      notes: [],
    });
  });

  test("a legacy tag passes with a note until the repin", () => {
    const report = checkCelldPin("0.6.3-noite.3", false);

    expect(report.errors).toEqual([]);
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain("legacy pre-fork pin");
  });

  test("a release refuses a legacy tag, so an alpha cannot ship a pre-fork image", () => {
    const report = checkCelldPin("0.6.3-noite.3", true);

    expect(report.notes).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("legacy pre-fork tag");
    expect(report.errors[0]).toContain("-ryuzcorp.<n>");
  });

  test("a missing or malformed pin fails either way", () => {
    for (const release of [false, true]) {
      for (const tag of [undefined, "0.6.3", "0.6.3-other.1"]) {
        const report = checkCelldPin(tag, release);

        expect(report.notes).toEqual([]);
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]).toContain("-ryuzcorp.<n>");
      }
    }
  });
});
