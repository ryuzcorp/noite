import { describe, expect, test } from "bun:test";

import {
  changesFingerprint,
  sanitizedLabel,
  workspacePreviewRef,
} from "./preview-env";
import type { WorkspaceChange } from "./workspace/types";

/** One change row: the defaults are a modified text file. */
const row = (
  path: string,
  after: string,
  extra: Partial<WorkspaceChange> = {}
): WorkspaceChange => ({ after, before: "", kind: "modified", path, ...extra });

describe("sanitizedLabel (the runner's env_label::sanitize_label)", () => {
  test("folds separators to single dashes", () => {
    expect(sanitizedLabel("Feature/New Thing")).toBe("feature-new-thing");
    expect(sanitizedLabel("fix__a--b")).toBe("fix-a-b");
    expect(sanitizedLabel("release/2026.10")).toBe("release-2026-10");
    expect(sanitizedLabel("-nope-")).toBe("nope");
    expect(sanitizedLabel("///")).toBe("env");
    expect(sanitizedLabel("")).toBe("env");
    // Non-ASCII is not a DNS label character; it folds like any separator.
    expect(sanitizedLabel("café/fix")).toBe("caf-fix");
  });

  test("caps at 40 characters without a trailing dash", () => {
    expect(sanitizedLabel("a".repeat(120))).toHaveLength(40);
    expect(sanitizedLabel(`${"a".repeat(39)}-tail`)).toBe("a".repeat(39));
    expect(sanitizedLabel("b".repeat(40))).toHaveLength(40);
  });
});

describe("workspacePreviewRef (the runner's preview_ref)", () => {
  test("is the sanitized user id and the branch, never a branch itself", () => {
    expect(
      workspacePreviewRef("3f1a9c22-0000-4000-8000-000000000001", "feat/x")
    ).toBe("refs/previews/3f1a9c22-0000-4000-8000-000000000001/feat/x");
    // An exotic id cannot make an un-writable ref name.
    expect(workspacePreviewRef("-", "main")).toBe("refs/previews/env/main");
  });
});

describe("changesFingerprint", () => {
  test("is the same change set whatever order it was derived in", () => {
    const first = row("src/a.ts", "one");
    const second = row("src/b.ts", "two", { kind: "added" });
    expect(changesFingerprint([first, second])).toBe(
      changesFingerprint([second, first])
    );
  });

  test("ignores the committed side while it is still being read", () => {
    const read = row("src/a.ts", "one", { before: "old" });
    const loading = row("src/a.ts", "one", { loading: true });
    expect(changesFingerprint([read])).toBe(changesFingerprint([loading]));
  });

  test("moves with the content, the path, the kind and a move's origin", () => {
    const base = changesFingerprint([row("src/a.ts", "one")]);
    expect(changesFingerprint([])).not.toBe(base);
    expect(changesFingerprint([row("src/a.ts", "two")])).not.toBe(base);
    expect(changesFingerprint([row("src/b.ts", "one")])).not.toBe(base);
    expect(
      changesFingerprint([row("src/a.ts", "one", { kind: "added" })])
    ).not.toBe(base);
    expect(changesFingerprint([row("src/a.ts", "", { binary: 3 })])).not.toBe(
      base
    );
    const moved = changesFingerprint([
      row("src/a.ts", "one", { kind: "moved", movedFrom: "src/old.ts" }),
    ]);
    const fromElsewhere = changesFingerprint([
      row("src/a.ts", "one", { kind: "moved", movedFrom: "src/other.ts" }),
    ]);
    expect(moved).not.toBe(fromElsewhere);
  });
});
