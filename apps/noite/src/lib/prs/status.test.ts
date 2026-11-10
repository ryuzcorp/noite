import { describe, expect, test } from "bun:test";

import type { PrDetail, PrReview } from "../runner";
import {
  mergeStateFacts,
  myVerdict,
  prCapabilities,
  prStateFacts,
  reviewStateFacts,
  switchStateAction,
  toMergeState,
  toPrState,
  toReviewState,
} from "./status";

const review = (over: Partial<PrReview> = {}): PrReview => ({
  commitSha: "head1",
  createdAt: "2026-01-01T00:00:00Z",
  dismissedAt: null,
  id: "r1",
  reviewerId: "u2",
  state: "approved",
  ...over,
});

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  approvals: 0,
  comments: [],
  compare: {
    ahead: 1,
    base: "main",
    baseSha: "base1",
    behind: 0,
    commits: [],
    conflicts: [],
    files: [],
    head: "feat",
    headSha: "head1",
    mergeBase: "base1",
    mergeable: true,
    patch: "",
    truncated: false,
  },
  mergeState: "mergeable",
  pullRequest: {
    authorId: "u1",
    base: "main",
    body: "",
    closedAt: null,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    head: "feat",
    headSha: "head1",
    mergeSha: null,
    mergedAt: null,
    mergedBy: null,
    number: 7,
    state: "open",
    title: "t",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  requirePr: false,
  requiredApprovals: 0,
  reviews: [],
  ...over,
});

describe("wire decoding", () => {
  test("known states keep their identity", () => {
    expect(toPrState("open")).toBe("open");
    expect(toPrState("merged")).toBe("merged");
    expect(toReviewState("changes_requested")).toBe("changes_requested");
    expect(toMergeState("blocked_approvals")).toBe("blocked_approvals");
  });

  test("an unknown state is inert, never mergeable", () => {
    // Fail-before: the header treated any state but "merged" as closable and
    // the badge rendered the raw string.
    expect(toPrState("archived")).toBe("closed");
    expect(toMergeState("archived")).toBe("conflicts");
    expect(toReviewState("archived")).toBeNull();
    expect(prStateFacts(toPrState("archived"))).toEqual(prStateFacts("closed"));
    expect(mergeStateFacts(toMergeState("archived")).label).toBe(
      "Merge conflicts"
    );
    expect(reviewStateFacts("archived")).toBeNull();
  });
});

describe("capabilities", () => {
  test("a push-role author can close and merge a mergeable pull", () => {
    const capabilities = prCapabilities({
      detail: detail(),
      role: "push",
      viewerId: "u1",
    });

    expect(capabilities).toEqual({
      canClose: true,
      canMerge: true,
      canReopen: false,
      canReview: false,
    });
    expect(switchStateAction("open", capabilities)).toBe("closed");
  });

  test("merge needs the merge state too", () => {
    // Fail-before: the header enabled Merge whenever the pull was open, while
    // the dropdown required mergeState === "mergeable"; a blocked pull
    // offered a button that always 409'd.
    const blocked = prCapabilities({
      detail: detail({ mergeState: "blocked_approvals" }),
      role: "admin",
      viewerId: "u3",
    });

    const conflicting = prCapabilities({
      detail: detail({ mergeState: "conflicts" }),
      role: "admin",
      viewerId: "u3",
    });

    expect(blocked.canMerge).toBe(false);
    expect(conflicting.canMerge).toBe(false);
  });

  test("reopen is only offered when the head branch still exists", () => {
    // Fail-before: Reopen was enabled for every non-merged pull, including a
    // close whose head branch was deleted (the runner always 409s).
    const closed = detail({
      compare: null,
      mergeState: "closed",
      pullRequest: { ...detail().pullRequest, state: "closed" },
    });

    const capabilities = prCapabilities({
      detail: closed,
      role: "push",
      viewerId: "u1",
    });

    expect(capabilities.canReopen).toBe(false);
    expect(capabilities.canClose).toBe(false);
    expect(switchStateAction("closed", capabilities)).toBeNull();
  });

  test("a viewer with no role gets no actions", () => {
    const capabilities = prCapabilities({
      detail: detail(),
      role: undefined,
      viewerId: "",
    });

    expect(capabilities).toEqual({
      canClose: false,
      canMerge: false,
      canReopen: false,
      canReview: false,
    });
  });
});

describe("my verdict", () => {
  test("a review at the current head counts", () => {
    expect(myVerdict(detail({ reviews: [review()] }), "u2")).toEqual({
      _tag: "Approved",
      current: true,
    });
  });

  test("a dismissed review and a stale head do not count", () => {
    expect(
      myVerdict(
        detail({ reviews: [review({ dismissedAt: "2026-01-02T00:00:00Z" })] }),
        "u2"
      )
    ).toEqual({ _tag: "Approved", current: false });
    expect(
      myVerdict(detail({ reviews: [review({ commitSha: "old" })] }), "u2")
    ).toEqual({ _tag: "Approved", current: false });
  });

  test("someone else's review is not mine", () => {
    expect(myVerdict(detail({ reviews: [review()] }), "u9")).toEqual({
      _tag: "None",
    });
  });
});
