import { describe, expect, test } from "bun:test";

import {
  completionRemainder,
  diagnosticsToMarkers,
  isScriptFile,
  lineStarts,
  offsetAtPosition,
  positionAtOffset,
  severityFromCategory,
  supportsPrediction,
} from "./intel-protocol";
import type { IntelCompletion, IntelDiagnostic } from "./intel-protocol";

/** A diagnostic covering `start`..`end` of the file under test. */
const diagnostic = (
  start: number,
  end: number,
  over: Partial<IntelDiagnostic> = {}
): IntelDiagnostic => ({
  code: 2322,
  end,
  message: "Type 'string' is not assignable to type 'number'.",
  severity: "error",
  start,
  ...over,
});

const completion = (over: Partial<IntelCompletion> = {}): IntelCompletion => ({
  insertText: "",
  kind: "const",
  name: "string",
  ...over,
});

describe("severityFromCategory", () => {
  test("maps TypeScript's DiagnosticCategory numbering", () => {
    expect(severityFromCategory(0)).toBe("warning");
    expect(severityFromCategory(1)).toBe("error");
    expect(severityFromCategory(2)).toBe("hint");
    expect(severityFromCategory(3)).toBe("info");
  });

  test("falls back to error for anything unknown", () => {
    expect(severityFromCategory(99)).toBe("error");
  });
});

describe("lineStarts / positions", () => {
  test("splits LF, CRLF and a lone CR alike", () => {
    expect(lineStarts("a\nb")).toEqual([0, 2]);
    expect(lineStarts("a\r\nb")).toEqual([0, 3]);
    expect(lineStarts("a\rb")).toEqual([0, 2]);
    expect(lineStarts("a\r\nb\rc\nd")).toEqual([0, 3, 5, 7]);
  });

  test("round-trips an offset through a position", () => {
    const text = "const x = 1;\nconst y = 2;\n";
    for (const offset of [0, 5, 12, 13, 25, 26]) {
      expect(
        offsetAtPosition(text, positionAtOffset(lineStarts(text), offset))
      ).toBe(offset);
    }
  });

  test("clamps out-of-range input instead of returning NaN", () => {
    const text = "ab\ncd";
    expect(positionAtOffset(lineStarts(text), 9999).line).toBe(1);
    expect(positionAtOffset(lineStarts(text), -5)).toEqual({
      character: 0,
      line: 0,
    });
    expect(offsetAtPosition(text, { character: 99, line: 0 })).toBe(2);
    expect(offsetAtPosition(text, { character: 1, line: 9 })).toBe(4);
  });
});

describe("diagnosticsToMarkers", () => {
  test("maps offsets to 0-based marker ranges and carries the error code", () => {
    const text = 'const x: number = "hi";\n';
    const start = text.indexOf('"hi"');
    const [marker] = diagnosticsToMarkers([diagnostic(start, start + 4)], text);
    expect(marker?.start).toEqual({ character: start, line: 0 });
    expect(marker?.end).toEqual({ character: start + 4, line: 0 });
    expect(marker?.severity).toBe("error");
    expect(marker?.message).toBe(
      "TS2322: Type 'string' is not assignable to type 'number'."
    );
  });

  test("lands on the right line of a multi-line file", () => {
    const text = "a\nbcd\n";
    const [marker] = diagnosticsToMarkers([diagnostic(2, 5)], text);
    expect(marker?.start).toEqual({ character: 0, line: 1 });
    expect(marker?.end).toEqual({ character: 3, line: 1 });
  });

  test("widens a zero-width diagnostic so the squiggle is visible", () => {
    const [marker] = diagnosticsToMarkers([diagnostic(4, 4)], "const x = 1;\n");
    expect(marker?.start).toEqual({ character: 4, line: 0 });
    expect(marker?.end).toEqual({ character: 5, line: 0 });
  });

  test("keeps warnings as warnings", () => {
    const [marker] = diagnosticsToMarkers(
      [diagnostic(0, 1, { code: 6133, severity: "warning" })],
      "unused\n"
    );
    expect(marker?.severity).toBe("warning");
  });
});

describe("completionRemainder", () => {
  test("returns only the part the word does not already cover", () => {
    expect(completionRemainder("const st", 8, completion())).toBe("ring");
  });

  test("falls back to the entry name when there is no insert text", () => {
    expect(
      completionRemainder("const st", 8, completion({ insertText: "" }))
    ).toBe("ring");
  });

  test("returns the whole insert at the start of a word", () => {
    expect(completionRemainder("const ", 6, completion({ name: "s" }))).toBe(
      "s"
    );
  });

  test("stays silent when nothing is left to insert", () => {
    expect(
      completionRemainder("const st", 8, completion({ name: "st" }))
    ).toBeNull();
  });

  test("stays silent for edits ghost text cannot render", () => {
    expect(
      completionRemainder("foo.", 4, completion({ insertText: 'bar("a")' }))
    ).toBeNull();
    expect(
      completionRemainder(
        "foo.",
        4,
        completion({ insertText: "./other/module" })
      )
    ).toBeNull();
    expect(
      completionRemainder("foo.", 4, completion({ insertText: "bar\nbaz" }))
    ).toBeNull();
  });

  test("stays silent when the entry does not match the typed word", () => {
    expect(
      completionRemainder("const xy", 8, completion({ name: "zzz" }))
    ).toBeNull();
  });
});

describe("script files", () => {
  test("recognizes the extensions the language service can read", () => {
    for (const path of [
      "src/main.ts",
      "src/view.tsx",
      "src/mod.mts",
      "src/mod.cts",
      "lib/a.js",
      "lib/a.jsx",
      "lib/a.mjs",
      "lib/a.cjs",
      "types/index.d.ts",
    ]) {
      expect(isScriptFile(path)).toBe(true);
    }
    for (const path of ["README.md", "package.json", "src/style.css"]) {
      expect(isScriptFile(path)).toBe(false);
    }
  });

  test("never predicts into declaration files", () => {
    expect(supportsPrediction("src/main.ts")).toBe(true);
    expect(supportsPrediction("types/index.d.ts")).toBe(false);
    expect(supportsPrediction("types/index.d.mts")).toBe(false);
  });
});
