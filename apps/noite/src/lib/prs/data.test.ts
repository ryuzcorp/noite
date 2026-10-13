import { describe, expect, test } from "bun:test";

import type { PrComment, PrReview } from "../runner";
import {
  attachesTo,
  buildTimeline,
  groupLineComments,
  lineAnchor,
  splitPatchFiles,
  threadsForPath,
  toPrStateFilter,
} from "./data";

const comment = (over: Partial<PrComment> & { id: string }): PrComment => ({
  authorId: "u1",
  body: "hello",
  commitSha: null,
  createdAt: "2026-01-01T00:00:00Z",
  editedAt: null,
  line: null,
  outdated: false,
  path: null,
  side: null,
  ...over,
});

const review = (over: Partial<PrReview> & { id: string }): PrReview => ({
  commitSha: "sha",
  createdAt: "2026-01-01T00:00:00Z",
  dismissedAt: null,
  reviewerId: "u2",
  state: "approved",
  ...over,
});

describe("buildTimeline", () => {
  test("merges comments and reviews in ascending createdAt order", () => {
    const timeline = buildTimeline(
      [
        comment({ createdAt: "2026-01-03T00:00:00Z", id: "c3" }),
        comment({ createdAt: "2026-01-01T00:00:00Z", id: "c1" }),
      ],
      [
        review({ createdAt: "2026-01-04T00:00:00Z", id: "r4" }),
        review({ createdAt: "2026-01-02T00:00:00Z", id: "r2" }),
      ]
    );
    expect(timeline.map((entry) => entry.id)).toEqual(["c1", "r2", "c3", "r4"]);
    expect(timeline.map((entry) => entry.kind)).toEqual([
      "comment",
      "review",
      "comment",
      "review",
    ]);
    expect(timeline[1]).toMatchObject({ kind: "review", review: { id: "r2" } });
    expect(timeline[0]).toMatchObject({
      comment: { id: "c1" },
      kind: "comment",
    });
  });

  test("equal timestamps tie-break by id, deterministically", () => {
    const same = "2026-05-05T12:00:00Z";
    const timeline = buildTimeline(
      [
        comment({ createdAt: same, id: "b" }),
        comment({ createdAt: same, id: "a" }),
      ],
      [review({ createdAt: same, id: "c" })]
    );
    expect(timeline.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

describe("line anchors", () => {
  test("lineAnchor needs path, line and a known side", () => {
    expect(
      lineAnchor(comment({ id: "x", line: 4, path: "a.ts", side: "new" }))
    ).toEqual({ line: 4, path: "a.ts", side: "new" });
    expect(lineAnchor(comment({ id: "y", line: 4, path: "a.ts" }))).toBeNull();
    expect(
      lineAnchor(comment({ id: "z", line: 4, path: "a.ts", side: "left" }))
    ).toBeNull();
    expect(lineAnchor(comment({ id: "w" }))).toBeNull();
  });

  test("attachesTo matches the exact file/line/side", () => {
    const anchored = comment({
      id: "x",
      line: 4,
      path: "a.ts",
      side: "new",
    });
    expect(attachesTo(anchored, "a.ts", 4, "new")).toBe(true);
    expect(attachesTo(anchored, "a.ts", 4, "old")).toBe(false);
    expect(attachesTo(anchored, "a.ts", 5, "new")).toBe(false);
    expect(attachesTo(anchored, "b.ts", 4, "new")).toBe(false);
    expect(attachesTo(comment({ id: "plain" }), "a.ts", 4, "new")).toBe(false);
  });
});

describe("groupLineComments", () => {
  test("groups by path, orders threads by line then side, comments by time", () => {
    const comments = [
      comment({
        createdAt: "2026-01-02T00:00:00Z",
        id: "t1",
        line: 9,
        path: "b.ts",
        side: "new",
      }),
      comment({ id: "plain" }),
      comment({ id: "t0", line: 2, path: "a.ts", side: "new" }),
      comment({
        createdAt: "2026-01-03T00:00:00Z",
        id: "t2",
        line: 9,
        path: "b.ts",
        side: "new",
      }),
      comment({ id: "t3", line: 1, path: "b.ts", side: "old" }),
    ];
    const groups = groupLineComments(comments);
    expect([...groups.keys()].toSorted()).toEqual(["a.ts", "b.ts"]);
    expect(groups.get("a.ts")?.map((thread) => thread.anchor.line)).toEqual([
      2,
    ]);
    const b = groups.get("b.ts") ?? [];
    expect(b.map((thread) => [thread.anchor.line, thread.anchor.side])).toEqual(
      [
        [1, "old"],
        [9, "new"],
      ]
    );
    expect(b[1]?.comments.map((entry) => entry.id)).toEqual(["t1", "t2"]);
  });

  test("threadsForPath returns one file's threads, empty when none", () => {
    const comments = [
      comment({ id: "one", line: 1, path: "a.ts", side: "old" }),
    ];
    expect(threadsForPath(comments, "a.ts")).toHaveLength(1);
    expect(threadsForPath(comments, "other.ts")).toEqual([]);
  });
});

describe("splitPatchFiles", () => {
  const patch = [
    "diff --git a/one.ts b/one.ts",
    "index 111..222 100644",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/two.ts b/two.ts",
    "index 333..444 100644",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");

  test("splits one chunk per file and names it from the +++ header", () => {
    const files = splitPatchFiles(patch);
    expect(files.map((file) => file.path)).toEqual(["one.ts", "two.ts"]);
    expect(files[0]?.patch.startsWith("diff --git a/one.ts")).toBe(true);
    expect(files[0]?.patch).not.toContain("two.ts");
  });

  test("falls back to the old path for a deletion", () => {
    const deleted = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    expect(splitPatchFiles(deleted)[0]?.path).toBe("gone.ts");
  });

  test("keeps a single-file patch intact and returns nothing for empty input", () => {
    const single = "diff --git a/only.ts b/only.ts\n+++ b/only.ts\n";
    expect(splitPatchFiles(single)).toHaveLength(1);
    expect(splitPatchFiles("")).toEqual([]);
  });
});

describe("toPrStateFilter", () => {
  test("accepts the four filters and defaults unknown values to open", () => {
    expect(toPrStateFilter("all")).toBe("all");
    expect(toPrStateFilter("closed")).toBe("closed");
    expect(toPrStateFilter("merged")).toBe("merged");
    expect(toPrStateFilter("nonsense")).toBe("open");
  });
});
