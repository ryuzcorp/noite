/** Pure pull-request view helpers: timeline ordering, diff-line anchors and
 * the patch splitter the Files tab renders per file. Kept free of ilha and
 * runner imports so `data.test.ts` can exercise it directly. */
import type { PrComment, PrReview } from "../runner";

// ---- Conversation timeline ----

export type TimelineEntry =
  | {
      createdAt: string;
      id: string;
      kind: "comment";
      comment: PrComment;
    }
  | {
      createdAt: string;
      id: string;
      kind: "review";
      review: PrReview;
    };

/** ISO stamps sort lexicographically only when normalized; Date.parse keeps
 * mixed formats honest (invalid stamps read as epoch 0). */
const timeOf = (value: string): number => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};

/** Ascending by createdAt, ties broken stably by id (ids are ULIDs, so the
 * tie order is deterministic across renders). */
export const buildTimeline = (
  comments: readonly PrComment[],
  reviews: readonly PrReview[]
): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];
  for (const comment of comments) {
    entries.push({
      comment,
      createdAt: comment.createdAt,
      id: comment.id,
      kind: "comment",
    });
  }
  for (const review of reviews) {
    entries.push({
      createdAt: review.createdAt,
      id: review.id,
      kind: "review",
      review,
    });
  }
  return entries.toSorted((a, b) => {
    const delta = timeOf(a.createdAt) - timeOf(b.createdAt);
    if (delta !== 0) {
      return delta;
    }
    if (a.id < b.id) {
      return -1;
    }
    return a.id > b.id ? 1 : 0;
  });
};

// ---- Diff-line anchors ----

export type DiffSide = "old" | "new";

export interface LineAnchor {
  line: number;
  path: string;
  side: DiffSide;
}

const toSide = (side: string | null): DiffSide | null =>
  side === "old" || side === "new" ? side : null;

/** The diff anchor a comment carries, or null for a conversation comment
 * (any of path/line/side missing or unrecognized). */
export const lineAnchor = (comment: PrComment): LineAnchor | null => {
  const side = toSide(comment.side);
  if (comment.path === null || comment.line === null || side === null) {
    return null;
  }
  return { line: comment.line, path: comment.path, side };
};

/** Whether a comment attaches to one diff file/line/side. */
export const attachesTo = (
  comment: PrComment,
  path: string,
  line: number,
  side: string
): boolean => {
  const anchor = lineAnchor(comment);
  return (
    anchor !== null &&
    anchor.path === path &&
    anchor.line === line &&
    anchor.side === side
  );
};

/** One thread: an anchor plus every comment recorded on it, oldest first. */
export interface LineThread {
  anchor: LineAnchor;
  comments: PrComment[];
}

/** Anchored comments grouped by path, each path's threads ordered by line
 * then side (old before new); the Files tab renders one thread per anchor. */
export const groupLineComments = (
  comments: readonly PrComment[]
): Map<string, LineThread[]> => {
  const pending = new Map<string, Map<string, LineThread>>();
  for (const comment of comments) {
    const anchor = lineAnchor(comment);
    if (anchor === null) {
      continue;
    }
    const key = `${anchor.line}:${anchor.side}`;
    let threads = pending.get(anchor.path);
    if (!threads) {
      threads = new Map();
      pending.set(anchor.path, threads);
    }
    const thread = threads.get(key);
    if (thread) {
      thread.comments.push(comment);
    } else {
      threads.set(key, { anchor, comments: [comment] });
    }
  }
  const grouped = new Map<string, LineThread[]>();
  for (const [path, threads] of pending) {
    const out = [...threads.values()].toSorted(
      (a, b) =>
        a.anchor.line - b.anchor.line ||
        (a.anchor.side === "old" ? 0 : 1) - (b.anchor.side === "old" ? 0 : 1)
    );
    for (const thread of out) {
      thread.comments.sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
    }
    grouped.set(path, out);
  }
  return grouped;
};

/** The threads that belong on one file's diff, or an empty list. */
export const threadsForPath = (
  comments: readonly PrComment[],
  path: string
): LineThread[] => groupLineComments(comments).get(path) ?? [];

// ---- Patch splitting (Files tab renders one viewer per file) ----

export interface PatchFile {
  patch: string;
  path: string;
}

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
};

/** Path from a `--- a/x` / `+++ b/x` header, minus the diff prefix; the
 * `/dev/null` side of an add/delete yields null. */
const headerPath = (line: string, prefix: "a/" | "b/"): string | null => {
  const value = stripQuotes(line.slice(4)).split("\t")[0] ?? "";
  if (value === "/dev/null" || value === "") {
    return null;
  }
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
};

/** Split a unified patch into one chunk per file. Pierre parses each chunk
 * on its own, so the Files tab can mount a viewer per file and map a click
 * to the file it hit. */
export const splitPatchFiles = (patch: string): PatchFile[] => {
  const lines = patch.split("\n");
  const files: PatchFile[] = [];
  let current: string[] = [];
  let path: string | null = null;
  let oldPath: string | null = null;

  const flush = () => {
    if (current.length > 0) {
      files.push({ patch: current.join("\n"), path: path ?? oldPath ?? "" });
    }
    current = [];
    path = null;
    oldPath = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(?<old>.+) b\/(?<new>.+)$/u.exec(line);
      const nextPath = match?.groups?.["new"];
      path = nextPath === undefined ? null : stripQuotes(nextPath);
      current.push(line);
      continue;
    }
    if (current.length > 0) {
      if (line.startsWith("+++ ")) {
        path = headerPath(line, "b/") ?? path;
      } else if (line.startsWith("--- ")) {
        oldPath = headerPath(line, "a/");
      }
      current.push(line);
    }
  }
  flush();
  return files;
};

// ---- List filters ----

export type PrStateFilter = "all" | "closed" | "merged" | "open";

/** Parse `?state=`: unknown values fall back to open. */
export const toPrStateFilter = (raw: string): PrStateFilter => {
  if (raw === "all" || raw === "closed" || raw === "merged" || raw === "open") {
    return raw;
  }
  return "open";
};
