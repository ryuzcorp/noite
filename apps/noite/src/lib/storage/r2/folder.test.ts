import { describe, expect, test } from "bun:test";

import {
  checkedVisible,
  cursorAt,
  emptySelection,
  nextFolder,
  nextSelection,
  prevFolder,
  R2Sel,
  startFolder,
} from "./folder";

describe("folder cursor stack", () => {
  test("walks forward, back, and drops the forward tokens", () => {
    const first = startFolder();
    expect(cursorAt(first)).toBe("");

    const second = nextFolder(first, "t1");
    expect(cursorAt(second)).toBe("t1");

    const third = nextFolder(second, "t2");
    expect(cursorAt(third)).toBe("t2");

    const back = prevFolder(third);
    expect(cursorAt(back)).toBe("t1");

    // Walking forward from a mid-stack page replaces the old forward token.
    const again = nextFolder(back, "t3");
    expect(again.cursors).toEqual(["", "t1", "t3"]);
    expect(cursorAt(again)).toBe("t3");
  });

  test("the first page has no previous page", () => {
    expect(prevFolder(startFolder())).toEqual(startFolder());
  });
});

describe("selection", () => {
  test("toggle and toggle-all work on the visible listing", () => {
    const toggled = nextSelection(
      emptySelection(),
      R2Sel.Toggle({ key: "a", on: true })
    );

    expect(toggled.checked).toEqual(["a"]);

    const all = nextSelection(
      toggled,
      R2Sel.ToggleAll({ visible: ["a", "b"] })
    );

    expect(all.checked).toEqual(["a", "b"]);

    const cleared = nextSelection(
      all,
      R2Sel.ToggleAll({ visible: ["a", "b"] })
    );

    expect(cleared.checked).toEqual([]);
  });

  test("a filtered-away check is never part of the delete payload", () => {
    // P1 fail-before: select all in a search, clear the search, press Delete —
    // the payload included objects the user could not see.
    const all = nextSelection(
      emptySelection(),
      R2Sel.ToggleAll({ visible: ["a", "b"] })
    );

    const searched = nextSelection(all, R2Sel.Sync({ visible: ["a"] }));

    expect(searched.checked).toEqual(["a"]);
    expect(checkedVisible(searched, ["a"])).toEqual(["a"]);
    // Even without a Sync, the payload is filtered to what is visible.
    expect(checkedVisible(all, ["a"])).toEqual(["a"]);
  });

  test("clearing checks keeps the focused object", () => {
    const withFocus = nextSelection(
      nextSelection(emptySelection(), R2Sel.Focus({ key: "a" })),
      R2Sel.Toggle({ key: "a", on: true })
    );

    const cleared = nextSelection(withFocus, R2Sel.Clear());

    expect(cleared.checked).toEqual([]);
    expect(cleared.focused).toBe("a");
  });
});
