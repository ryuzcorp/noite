import { describe, expect, test } from "bun:test";

import { planCells, planE2E, resolveSuite } from "./e2e-plan";

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

describe("resolveSuite", () => {
  test("a schedule's empty --suite plans the nightly release suite", () => {
    // `schedule` has no workflow inputs, so e2e.yml hands `--suite ''`.
    // Before this, the plan job died there every night (run 45191949490).
    expect(resolveSuite("")).toBe("release");
  });

  test("an explicit suite passes through", () => {
    expect(resolveSuite("fast")).toBe("fast");
    expect(resolveSuite("release")).toBe("release");
  });

  test("anything else still fails closed", () => {
    for (const bad of ["Fast", " nightly", "release "]) {
      expect(() => resolveSuite(bad)).toThrow(/must be fast or release/u);
    }
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

describe("planCells", () => {
  const lanes = [
    { lane: "single", shard1: 12, shard2: 12, target: "e2e" },
    { lane: "multi", shard1: 5, shard2: 5, target: "e2e-isolation" },
  ];

  test("balanced shards keep both cells, crossed with rounds", () => {
    const cells = planCells(lanes, [1, 2]);

    expect(cells).toEqual([
      { lane: "single", round: 1, shard: 1, target: "e2e", total: 2 },
      { lane: "single", round: 2, shard: 1, target: "e2e", total: 2 },
      { lane: "single", round: 1, shard: 2, target: "e2e", total: 2 },
      { lane: "single", round: 2, shard: 2, target: "e2e", total: 2 },
      { lane: "multi", round: 1, shard: 1, target: "e2e-isolation", total: 2 },
      { lane: "multi", round: 2, shard: 1, target: "e2e-isolation", total: 2 },
      { lane: "multi", round: 1, shard: 2, target: "e2e-isolation", total: 2 },
      { lane: "multi", round: 2, shard: 2, target: "e2e-isolation", total: 2 },
    ]);
  });

  test("an empty shard collapses to one unsharded cell (the #359 shape)", () => {
    const cells = planCells(
      [{ lane: "multi", shard1: 17, shard2: 0, target: "e2e-isolation" }],
      [1]
    );

    expect(cells).toEqual([
      { lane: "multi", round: 1, shard: 1, target: "e2e-isolation", total: 1 },
    ]);
  });

  test("lanes decide independently", () => {
    const cells = planCells(
      [
        { lane: "single", shard1: 12, shard2: 12, target: "e2e" },
        { lane: "multi", shard1: 17, shard2: 0, target: "e2e-isolation" },
      ],
      [1]
    );

    expect(cells).toEqual([
      { lane: "single", round: 1, shard: 1, target: "e2e", total: 2 },
      { lane: "single", round: 1, shard: 2, target: "e2e", total: 2 },
      { lane: "multi", round: 1, shard: 1, target: "e2e-isolation", total: 1 },
    ]);
  });

  test("a lane with zero tests fails the plan instead of passing vacuously", () => {
    expect(() =>
      planCells([{ lane: "single", shard1: 0, shard2: 0, target: "e2e" }], [1])
    ).toThrow(/no tests/iu);
  });
});
