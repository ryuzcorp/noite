import { describe, expect, test } from "bun:test";

import { planE2E } from "./e2e-plan";

describe("planE2E", () => {
  test("a rewritten spec joins the fast run in full", () => {
    const plan = planE2E(["apps/noite/e2e/admin.spec.ts"], "fast");

    expect(plan.suite).toBe("fast");
    expect(plan.extraSpecs).toEqual(["admin.spec.ts"]);
    expect(plan.runRelease).toBe(false);
  });

  test("added and renamed specs are selected, deleted specs are not", () => {
    const plan = planE2E(
      [
        "apps/noite/e2e/create.spec.ts",
        "apps/noite/e2e/deploy.spec.ts",
        "apps/noite/src/lib/admin/users.tsx",
      ],
      "fast"
    );

    expect(plan.extraSpecs).toEqual(["create.spec.ts", "deploy.spec.ts"]);
    expect(plan.suite).toBe("fast");
  });

  test("a-invite is excluded: the policy project already runs it fully", () => {
    const plan = planE2E(["apps/noite/e2e/a-invite.spec.ts"], "fast");

    expect(plan.extraSpecs).toEqual([]);
    expect(plan.suite).toBe("fast");
    expect(plan.runRelease).toBe(false);
  });

  test("a changed shared helper escalates the gate to the release suite", () => {
    for (const helper of [
      "apps/noite/e2e/helpers.ts",
      "apps/noite/e2e/fixtures/mail.ts",
      "apps/noite/e2e/auth.setup.ts",
      "apps/noite/playwright.config.ts",
      "apps/noite/e2e/pages/admin.ts",
    ]) {
      const plan = planE2E([helper], "fast");

      expect(plan.suite).toBe("release");
      expect(plan.runRelease).toBe(true);
    }
  });

  test("a helper change still names the rewritten specs it came with", () => {
    const plan = planE2E(
      ["apps/noite/e2e/helpers.ts", "apps/noite/e2e/admin.spec.ts"],
      "fast"
    );

    expect(plan.suite).toBe("release");
    expect(plan.extraSpecs).toEqual(["admin.spec.ts"]);
  });

  test("a release request stays release and selects nothing extra", () => {
    const plan = planE2E(["apps/noite/e2e/admin.spec.ts"], "release");

    expect(plan.suite).toBe("release");
    expect(plan.extraSpecs).toEqual([]);
    expect(plan.runRelease).toBe(false);
  });

  test("no spec changes means an identical fast plan", () => {
    const plan = planE2E(["apps/noite/src/lib/admin/users.tsx"], "fast");

    expect(plan.suite).toBe("fast");
    expect(plan.extraSpecs).toEqual([]);
    expect(plan.runRelease).toBe(false);
  });

  test("selection is deduplicated and deterministic", () => {
    const plan = planE2E(
      [
        "apps/noite/e2e/deploy.spec.ts",
        "apps/noite/e2e/admin.spec.ts",
        "apps/noite/e2e/deploy.spec.ts",
      ],
      "fast"
    );

    expect(plan.extraSpecs).toEqual(["admin.spec.ts", "deploy.spec.ts"]);
  });
});

describe("hostile diff paths fail closed", () => {
  test("an embedded newline throws instead of forging an output line", () => {
    expect(() => planE2E(["apps/noite/e2e/ad\nmin.spec.ts"], "fast")).toThrow(
      /unsafe path/u
    );
  });

  test("command substitution in a filename throws", () => {
    expect(() =>
      planE2E(["apps/noite/e2e/$(touch pwned).spec.ts"], "fast")
    ).toThrow(/unsafe path/u);
  });

  test("quotes, backticks and whitespace throw", () => {
    for (const hostile of [
      "apps/noite/e2e/ad'min.spec.ts",
      'apps/noite/e2e/ad"min.spec.ts',
      "apps/noite/e2e/`id`.spec.ts",
      "apps/noite/e2e/ad min.spec.ts",
      "apps/noite/e2e/\tadmin.spec.ts",
    ]) {
      expect(() => planE2E([hostile], "fast")).toThrow(/unsafe path/u);
    }
  });

  test("bracketed file-routed pages stay allowed", () => {
    const plan = planE2E(["apps/noite/src/pages/apps/[id].tsx"], "fast");

    expect(plan.suite).toBe("fast");
  });
});
