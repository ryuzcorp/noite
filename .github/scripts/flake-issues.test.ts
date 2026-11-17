import { describe, expect, test } from "bun:test";

import { collectFailures, missingReports } from "./flake-issues";

const suite = (tests: { status: string; results: { status: string }[] }[]) => [
  {
    file: "e2e/a.spec.ts",
    specs: [
      {
        file: "e2e/a.spec.ts",
        tests: tests.map((entry) => ({
          results: entry.results.map((result) => ({
            error: { message: `boom (${result.status})` },
            status: result.status,
          })),
          status: entry.status,
        })),
        title: "does x",
      },
    ],
    title: "e2e/a.spec.ts",
  },
];

describe("collectFailures", () => {
  test("a test.fail() that failed as declared is green, never filed", () => {
    expect(
      collectFailures(
        suite([{ results: [{ status: "failed" }], status: "expected" }]),
        [],
        undefined,
        []
      )
    ).toEqual([]);
  });

  test("a test.fail() that passed is filed as an unexpected pass", () => {
    const [failure] = collectFailures(
      suite([{ results: [{ status: "passed" }], status: "unexpected" }]),
      [],
      undefined,
      []
    );

    expect(failure?.status).toBe("unexpected pass");
    expect(failure?.error).toContain("declared to fail");
  });

  test("an unexpected failure carries its failing result's error", () => {
    const [failure] = collectFailures(
      suite([{ results: [{ status: "timedOut" }], status: "unexpected" }]),
      [],
      undefined,
      []
    );

    expect(failure?.status).toBe("timedOut");
    expect(failure?.error).toBe("boom (timedOut)");
    expect(failure?.title).toBe("e2e/a.spec.ts › does x");
  });

  test("skipped and passing tests file nothing", () => {
    expect(
      collectFailures(
        suite([
          { results: [], status: "skipped" },
          { results: [{ status: "passed" }], status: "expected" },
        ]),
        [],
        undefined,
        []
      )
    ).toEqual([]);
  });
});

describe("missingReports", () => {
  const cells = [
    { lane: "single", shard: 1 },
    { lane: "single", shard: 2 },
    { lane: "multi", shard: 1 },
    { lane: "multi", shard: 2 },
  ];

  test("every planned lane, round and shard must have reported", () => {
    const present = new Set(["single-r1-s1", "single-r1-s2", "multi-r1-s1"]);

    expect(missingReports(present, cells, [1])).toEqual(["multi-r1-s2"]);
  });

  test("a full matrix is complete", () => {
    const present = new Set([
      "single-r1-s1",
      "single-r1-s2",
      "single-r2-s1",
      "single-r2-s2",
    ]);

    const single = cells.filter((cell) => cell.lane === "single");

    expect(missingReports(present, single, [1, 2])).toEqual([]);
  });

  test("an unsharded lane expects only its single cell", () => {
    const present = new Set(["multi-r1-s1"]);

    expect(missingReports(present, [{ lane: "multi", shard: 1 }], [1])).toEqual(
      []
    );
  });
});
