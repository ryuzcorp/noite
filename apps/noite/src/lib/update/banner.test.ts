import { describe, expect, test } from "bun:test";

import type { RunnerUpdateStatus } from "../runner";
import { shouldShowUpdateBanner } from "./decision";

const status = (
  override: Partial<RunnerUpdateStatus> = {}
): RunnerUpdateStatus => ({
  checkedAt: "2026-10-21T00:00:00.000Z",
  current: "0.1.0-alpha.8",
  enabled: true,
  latest: "0.1.0-alpha.9",
  lockReason: null,
  locked: false,
  notesUrl: "https://github.com/ryuzcorp/noite/releases/tag/v0.1.0-alpha.9",
  setting: true,
  ...override,
});

describe("shouldShowUpdateBanner", () => {
  test("shows the banner to an admin with a newer release", () => {
    expect(shouldShowUpdateBanner(status(), true, null)).toBe(true);
  });

  test("members never see it", () => {
    expect(shouldShowUpdateBanner(status(), false, null)).toBe(false);
  });

  test("hidden when the check is off or nothing newer was seen", () => {
    expect(shouldShowUpdateBanner(status({ enabled: false }), true, null)).toBe(
      false
    );
    expect(shouldShowUpdateBanner(status({ latest: null }), true, null)).toBe(
      false
    );
    expect(shouldShowUpdateBanner(undefined, true, null)).toBe(false);
  });

  test("dismissal hides the banner for that version only", () => {
    expect(shouldShowUpdateBanner(status(), true, "0.1.0-alpha.9")).toBe(false);
    expect(
      shouldShowUpdateBanner(
        status({
          latest: "0.1.0-alpha.10",
          notesUrl:
            "https://github.com/ryuzcorp/noite/releases/tag/v0.1.0-alpha.10",
        }),
        true,
        "0.1.0-alpha.9"
      )
    ).toBe(true);
  });
});
