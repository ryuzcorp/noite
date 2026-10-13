//! The preview's live command lines, beside the child handles: what the
//! terminal's process strip and its `preview` command show. A line is added
//! when a child spawns, leaves when its child exits, and `clear` drops what
//! killing leaves behind. A module of its own (rather than inline in
//! `start.ts`) so the add/remove edge is unit-testable — `start.ts` itself
//! only loads under vite, through the harness's `import.meta.glob`s.

import type { PreviewProcess } from "./types";

/** The live lines of one preview: spawn adds, exit removes, halt clears. */
export interface LiveCommands {
  add: (child: PreviewProcess, line: string) => void;
  clear: () => void;
  lines: () => string[];
  remove: (child: PreviewProcess) => void;
}

/** An empty ledger, oldest first. Removing an unknown child is a no-op: an
 * exit that races a halt must not take another line down with it. */
export const liveCommands = (): LiveCommands => {
  const entries: { child: PreviewProcess; line: string }[] = [];
  return {
    add: (child, line) => {
      entries.push({ child, line });
    },
    clear: () => {
      entries.length = 0;
    },
    lines: () => entries.map((entry) => entry.line),
    remove: (child) => {
      const at = entries.findIndex((entry) => entry.child === child);
      if (at !== -1) {
        entries.splice(at, 1);
      }
    },
  };
};
