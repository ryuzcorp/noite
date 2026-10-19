//! The Preview panel's snapshot payload: the same shape a push sends (writes,
//! with bytes that are not text carried as base64; the journal's renames; and
//! the paths the branch no longer has), built from the change rows the pane
//! already derived and the pod's own bytes. `workspace/push.ts` builds a
//! commit's payload inside the frame, as part of its push transaction — a
//! preview commits to a hidden ref and must leave the checkout exactly as it
//! was, base index and journal included, so its payload is built here instead.

import { bytesToBase64 } from "../bytes";
import { isBinary } from "./workspace/git";
import { JOURNAL_FILE, projectPath } from "./workspace/types";
import type {
  Journal,
  PushFile,
  PushMove,
  PushPayload,
  SourceFs,
  WorkspaceChange,
} from "./workspace/types";

const DECODER = new TextDecoder();

/** One path's text, or its bytes as base64 when they are not text at all (the
 * runner decodes them back). Mirrors `pushFile` in `workspace/push.ts`. */
const snapshotFile = async (
  fs: SourceFs,
  change: WorkspaceChange
): Promise<PushFile> => {
  const bytes = await fs.readFile(projectPath(change.path));

  return isBinary(bytes)
    ? { content: bytesToBase64(bytes), encoding: "base64", path: change.path }
    : { content: DECODER.decode(bytes), path: change.path };
};

/** What the snapshot writes, renames and drops. `journal` is the changed
 * paths' map: a move the UI journalled travels as a rename, one it did not as
 * a write plus the committed path's deletion (see `pushPayload`). */
const splitRemovals = (
  changes: readonly WorkspaceChange[],
  journal: Journal
) => {
  const deletes: string[] = [];
  const moves: PushMove[] = [];

  for (const change of changes) {
    if (change.kind === "deleted") {
      deletes.push(change.path);
      continue;
    }

    const { movedFrom } = change;

    if (change.kind !== "moved" || movedFrom === undefined) {
      continue;
    }

    if (journal[change.path] === movedFrom) {
      moves.push({ from: movedFrom, to: change.path });
    } else {
      deletes.push(movedFrom);
    }
  }

  return { deletes, moves };
};

/** Whether `value` is the string a journal entry must be. */
const isText = (value: unknown): value is string => typeof value === "string";

/** `moves.json` as the journal it must be: current path → committed path. */
const isJournal = (value: unknown): value is Journal =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((from) => isText(from));

/** The pod's move journal; an absent file is an empty one, and a file that is
 * not a journal is refused rather than guessed at (a wrong guess would drop a
 * rename's committed path), exactly as the frame reads it. */
const readJournal = async (fs: SourceFs): Promise<Journal> => {
  if (!(await fs.exists(JOURNAL_FILE))) {
    return {};
  }

  const parsed: unknown = JSON.parse(
    DECODER.decode(await fs.readFile(JOURNAL_FILE))
  );

  if (!isJournal(parsed)) {
    throw new Error("workspace: moves.json does not hold a move journal");
  }

  return parsed;
};

/** The preview snapshot of `changes`: the payload the runner commits to the
 * hidden preview ref. */
export const previewPayload = async (
  fs: SourceFs,
  changes: readonly WorkspaceChange[]
): Promise<PushPayload> => {
  const journal = await readJournal(fs);

  const files = await Promise.all(
    changes.flatMap((change) =>
      change.kind === "deleted" ? [] : [snapshotFile(fs, change)]
    )
  );

  const { deletes, moves } = splitRemovals(changes, journal);

  return { deletes, files, moves };
};
