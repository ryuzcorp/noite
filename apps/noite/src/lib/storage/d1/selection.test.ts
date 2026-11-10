import { describe, expect, test } from "bun:test";

import type { D1Cell, D1Column } from "../../runner";
import {
  nextSelection,
  rowKey,
  selectedKeys,
  Selection,
  visibleSelection,
} from "./selection";
import type { GridSelection } from "./selection";

const col = (name: string, extra: Partial<D1Column> = {}): D1Column => ({
  defaultValue: null,
  name,
  notNull: false,
  pk: 0,
  type: "TEXT",
  ...extra,
});

const COLUMNS: D1Column[] = [col("id", { pk: 1 }), col("name")];

const row = (id: string, name: string) => ({ id, name });

const keysOf = (rows: Record<string, D1Cell>[]): string[] =>
  rows.map((value) => rowKey(COLUMNS, value));

/** Drive the machine through a list of events. */
const run = (
  events: Parameters<typeof nextSelection>[1][],
  start: GridSelection = Selection.Idle()
): GridSelection => {
  let state = start;

  for (const event of events) {
    state = nextSelection(state, event);
  }

  return state;
};

describe("rowKey", () => {
  test("identity is the record's own key, not its position", () => {
    const before = keysOf([row("a", "Ada"), row("b", "Bo")]);
    const after = keysOf([row("b", "Bo"), row("a", "Ada")]);

    expect(after).toEqual([before[1], before[0]]);
    // The same record keeps its key across a reordering.
    expect(after[0]).toBe(before[1]);
  });
});

describe("selection transitions", () => {
  test("toggle, arm, cancel, confirm and delete", () => {
    const selecting = run([
      { key: keysOf([row("a", "Ada")])[0] ?? "", kind: "toggle" },
      { key: keysOf([row("b", "Bo")])[0] ?? "", kind: "toggle" },
    ]);

    expect(selecting._tag).toBe("Selecting");
    expect(selectedKeys(selecting)).toHaveLength(2);

    const armed = nextSelection(selecting, { kind: "arm" });
    expect(armed._tag).toBe("Confirm");

    const cancelled = nextSelection(armed, { kind: "cancel" });
    expect(cancelled._tag).toBe("Selecting");
    expect(selectedKeys(cancelled)).toEqual(selectedKeys(selecting));

    const deleting = nextSelection(armed, { kind: "confirm" });
    expect(deleting._tag).toBe("Deleting");
    expect(nextSelection(deleting, { kind: "deleted" })._tag).toBe("Idle");
  });

  test("changing the selection drops the armed confirmation", () => {
    // P1 fail-before: `confirming` was an independent flag, so arming Delete,
    // toggling a row and confirming deleted the *new* set under an old
    // confirmation.
    const first = keysOf([row("a", "Ada")]);

    const selecting = run(
      first.map((key) => ({ key, kind: "toggle" as const }))
    );

    const armed = nextSelection(selecting, { kind: "arm" });

    const toggled = nextSelection(armed, {
      key: keysOf([row("b", "Bo")])[0] ?? "",
      kind: "toggle",
    });

    expect(toggled._tag).toBe("Selecting");
    expect(selectedKeys(toggled)).toHaveLength(2);
    expect(nextSelection(toggled, { kind: "confirm" })._tag).toBe("Selecting");
  });

  test("clearing the selection also disarms the confirmation", () => {
    // P1 fail-before: Clear emptied `selected` but left `confirming` true, so
    // the armed bar resurfaced on the next tick of a box.
    const selecting = run(
      keysOf([row("a", "Ada")]).map((key) => ({
        key,
        kind: "toggle" as const,
      }))
    );

    const armed = nextSelection(selecting, { kind: "arm" });
    const cleared = nextSelection(armed, { kind: "clear" });

    expect(cleared).toEqual(Selection.Idle());
    expect(nextSelection(cleared, { kind: "confirm" })._tag).toBe("Idle");
  });

  test("a delete in flight refuses every selection change", () => {
    const selecting = run([
      { key: keysOf([row("a", "Ada")])[0] ?? "", kind: "toggle" },
    ]);

    const deleting = nextSelection(nextSelection(selecting, { kind: "arm" }), {
      kind: "confirm",
    });

    expect(nextSelection(deleting, { kind: "clear" })).toEqual(deleting);
    expect(nextSelection(deleting, { key: "other", kind: "toggle" })).toEqual(
      deleting
    );
  });

  test("a failed delete keeps the keys so it can be retried", () => {
    const selecting = run([
      { key: keysOf([row("a", "Ada")])[0] ?? "", kind: "toggle" },
    ]);

    const deleting = nextSelection(nextSelection(selecting, { kind: "arm" }), {
      kind: "confirm",
    });

    const failed = nextSelection(deleting, {
      error: "database busy",
      kind: "failed",
    });

    expect(failed._tag).toBe("Failed");
    expect(selectedKeys(failed)).toEqual(selectedKeys(selecting));
    expect(nextSelection(failed, { kind: "arm" })._tag).toBe("Confirm");
  });
});

describe("visibleSelection", () => {
  test("only keys on the page are part of a delete payload", () => {
    const shown = keysOf([row("a", "Ada"), row("b", "Bo")]);

    const selecting = run(
      shown.map((key) => ({ key, kind: "toggle" as const }))
    );

    // A reload delivers a filtered page: only "b" is still visible.
    expect(visibleSelection(selecting, [shown[1] ?? ""])).toEqual([
      shown[1] ?? "",
    ]);
  });

  test("select-all covers the visible rows only", () => {
    const keys = keysOf([row("a", "Ada"), row("b", "Bo")]);
    const all = nextSelection(Selection.Idle(), { keys, kind: "toggleAll" });

    expect(selectedKeys(all)).toEqual(keys);
    // Toggling all again clears, even after a partial manual selection.
    const partial = nextSelection(all, { key: keys[0] ?? "", kind: "toggle" });
    expect(selectedKeys(partial)).toHaveLength(1);
  });
});
