//! Wire protocol and pure mapping helpers shared by the language-service
//! worker and its main-thread client.
//!
//! Nothing here may import `typescript-ls` (that would put the compiler in the
//! main bundle) or touch the DOM: the module is plain data plus the small
//! conversions that are worth unit-testing — offsets ↔ positions, TypeScript
//! severities, diagnostics → pierre markers, completion remainder.
//!
//! Positions are pierre-shaped: 0-based line, 0-based character counted in
//! UTF-16 units. Pierre's piece table indexes by JS string offsets and
//! TypeScript's own offsets are JS string indices too, so both sides agree
//! without an encoding dance.

import type { Marker, MarkerSeverity } from "@pierre/diffs/edit";

/** A file in the browser's virtual FS: repository-relative path, full text. */
export interface IntelFile {
  path: string;
  text: string;
}

/** `source.bundle` payload: the repo's own text sources at the browsing ref. */
export interface IntelBundle {
  sha: string;
  files: IntelFile[];
  truncated: boolean;
}

/** `source.types` payload: declarations from the app's last successful build. */
export interface IntelTypes {
  sha: string | null;
  files: IntelFile[];
  truncated: boolean;
}

/** Both payloads, as the client's `sync`/`reset` take them. */
export interface IntelSources {
  bundle: IntelBundle;
  types: IntelTypes;
}

/** Pierre position: 0-based line, 0-based character inside that line. */
export interface IntelPosition {
  line: number;
  character: number;
}

/** Pierre marker severity, one-to-one with TypeScript's categories. */
export type IntelSeverity = MarkerSeverity;

/** One diagnostic, as the worker reports it: offsets into the file's text. */
export interface IntelDiagnostic {
  start: number;
  end: number;
  message: string;
  severity: IntelSeverity;
  /** TypeScript error code (2322, 1005, …). */
  code: number;
}

/** Rendered hover: the TypeScript signature (shown as highlighted code) and
 * the JSDoc lines under it (plain text). */
export interface IntelQuickInfo {
  signature: string;
  docs: string[];
}

/** Where a symbol is defined. `preview` carries a few declaration lines for
 * targets the pane cannot open (things that live in `node_modules` or in the
 * lib `.d.ts` bundled with the compiler). */
export interface IntelDefinition {
  path: string;
  start: IntelPosition;
  preview?: string[];
}

/** The most relevant completion at the cursor. */
export interface IntelCompletion {
  name: string;
  insertText: string;
  kind: string;
}

/** Requests the worker understands. `sync` is the only one that (re)builds the
 * program; `update` carries a live editor draft. */
export type IntelRequest =
  | {
      id: number;
      kind: "sync";
      bundle: IntelBundle;
      types: IntelTypes;
      drafts: IntelFile[];
    }
  | { kind: "update"; path: string; text: string }
  | { id: number; kind: "diagnostics"; path: string }
  | { id: number; kind: "quickInfo"; path: string; offset: number }
  | { id: number; kind: "definition"; path: string; offset: number }
  | { id: number; kind: "completion"; path: string; offset: number };

/** Replies: one per id-bearing request (`update` is fire-and-forget). A reply
 * value is what the request kind answers with — `null` means "nothing to
 * say", never a failure (that is the `ok: false` arm). */
export type IntelResult =
  | IntelCompletion
  | IntelDefinition
  | IntelDiagnostic[]
  | IntelQuickInfo
  | null;

export type IntelReply = { id: number } & (
  | { ok: true; value: IntelResult }
  | { ok: false; error: string }
);

/** Extensions the language service can work with (`.d.ts` included: the
 * browser opens declarations and still wants hover/definition there). */
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/u;

/** Declaration files: analysable, never a prediction target. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

/** Whether the language service can say anything about this path. */
export const isScriptFile = (path: string): boolean => SCRIPT_FILE.test(path);

/** Whether the path may take inline prediction (declarations are generated
 * text, and predicting into them would offer edits nobody typed). */
export const supportsPrediction = (path: string): boolean =>
  isScriptFile(path) && !DECLARATION_FILE.test(path);

/** TypeScript's `DiagnosticCategory` numbering, mapped to pierre's severities
 * (warning 0, error 1, suggestion 2, message 3). Resolved on the worker's side
 * so the main thread needs no `typescript` import. */
export const severityFromCategory = (category: number): IntelSeverity => {
  if (category === 0) {
    return "warning";
  }
  if (category === 2) {
    return "hint";
  }
  if (category === 3) {
    return "info";
  }
  return "error";
};

/** Offsets of every line start, splitting `\r\n` / `\r` / `\n` exactly as
 * TypeScript's own line map does (a lone `\r` breaks; `\r\n` is one break). */
export const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        i += 1;
      }
      starts.push(i + 1);
    } else if (code === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
};

/** Line/character for a UTF-16 offset (binary search over `starts`). */
export const positionAtOffset = (
  starts: readonly number[],
  offset: number
): IntelPosition => {
  const clamped = Math.max(0, offset);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= clamped) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { character: clamped - (starts[low] ?? 0), line: low };
};

/** UTF-16 offset for a line/character position, both clamped into the text. */
export const offsetAtPosition = (
  text: string,
  position: IntelPosition
): number => {
  const starts = lineStarts(text);
  const line = Math.min(Math.max(position.line, 0), starts.length - 1);
  const start = starts[line] ?? 0;
  const end = starts[line + 1] ?? text.length + 1;
  return Math.min(start + Math.max(position.character, 0), end - 1);
};

/** Diagnostics as pierre markers. Zero-width diagnostics get a one-character
 * range so the squiggle is visible, and the message carries the error code
 * (pierre's marker popover renders `message` only). */
export const diagnosticsToMarkers = (
  diagnostics: readonly IntelDiagnostic[],
  text: string
): Marker[] => {
  const starts = lineStarts(text);
  return diagnostics.map((diagnostic) => ({
    end: positionAtOffset(
      starts,
      Math.max(diagnostic.end, diagnostic.start + 1)
    ),
    message: `TS${diagnostic.code}: ${diagnostic.message}`,
    severity: diagnostic.severity,
    source: "typescript",
    start: positionAtOffset(starts, diagnostic.start),
  }));
};

/** The identifier characters a completion may extend leftwards. */
const IDENTIFIER_TAIL = /[\w$]+$/u;

/** The text inline prediction still has to insert at `offset`: the completion's
 * insert text minus the word already typed. Null when nothing is left to add,
 * or when the entry is not a plain single-line identifier — ghost text cannot
 * render snippets or quoted insertions, and predicting those would be worse
 * than staying silent. */
export const completionRemainder = (
  text: string,
  offset: number,
  completion: IntelCompletion
): string | null => {
  const insert =
    completion.insertText === "" ? completion.name : completion.insertText;
  const prefix =
    text.slice(0, Math.max(offset, 0)).match(IDENTIFIER_TAIL)?.[0] ?? "";
  if (!insert.startsWith(prefix)) {
    return null;
  }
  const remainder = insert.slice(prefix.length);
  return /^[\w$]+$/u.test(remainder) ? remainder : null;
};
