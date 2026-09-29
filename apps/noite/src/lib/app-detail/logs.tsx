//! Live runtime log tail (+ scroll memory).
import { atom, watch } from "ilha";

import { decodeLogs, feedKeys, liveFeed, logsUrl } from "../feeds";
import { collectRef, liveEl, newLiveRef } from "../live-ref";
import type { LiveRef } from "../live-ref";

/** Mutable per-instance pane state (see the atom.lazy note below). */
interface Pane {
  /** The live <pre>: re-renders hand `ref` detached copies too (live-ref.ts). */
  pre: LiveRef<HTMLPreElement>;
  stick: boolean;
}

const newPane = (): Pane => ({
  pre: newLiveRef<HTMLPreElement>(),
  stick: true,
});

/**
 * Live tail of the running celld fleet's stdout/stderr (bounded buffer on the
 * runner). Streams SSE and follows the tail while pinned to the bottom;
 * scrolled-up stays put. The buffer resets on runner restart, so this is
 * recent activity only.
 */
export const RuntimeLogs = ({ appId }: { appId: string }) => {
  const feed = liveFeed(feedKeys.logs(appId), logsUrl(appId), decodeLogs);
  const lines = (): string[] => feed.latest() ?? [];
  const retrying = (): boolean => feed.status() === "retrying";
  // Pane state must survive re-renders: this body re-runs on every frame
  // (it reads feed.latest()), so plain `let`s would reset `stick` to true
  // each line and yank a scrolled-up reader back down. atom.lazy runs once
  // per slot and hands back the same mutable box on every render.
  const pane = atom.lazy(newPane)();
  watch(feed.latest, (next) => {
    if (!next) {
      return;
    }
    // The watch fires before ilha's (microtask) re-render patches the new
    // lines in; scroll on the next frame, once scrollHeight includes them.
    window.requestAnimationFrame(() => {
      const pre = liveEl(pane.pre);
      if (pane.stick && pre) {
        pre.scrollTop = pre.scrollHeight;
      }
    });
  });

  return (
    <div class="flex flex-col gap-2">
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          Log stream disconnected — retrying…
        </p>
      ) : null}
      {lines().length === 0 && !retrying() ? (
        <p class="m-0 text-sm opacity-70">
          No output yet from the running fleet.
        </p>
      ) : (
        <pre
          class="max-h-64 overflow-auto rounded font-mono text-xs whitespace-pre-wrap"
          ref={(el) => {
            collectRef(pane.pre, el);
            if (el && pane.stick) {
              el.scrollTop = el.scrollHeight;
            }
          }}
          onscroll={(e) => {
            const target = e.currentTarget;
            pane.stick =
              target.scrollHeight - target.scrollTop - target.clientHeight < 24;
          }}
        >
          {lines().join("\n")}
        </pre>
      )}
    </div>
  );
};
