//! Live runtime log tail (+ scroll memory).
import { atom, watch } from "ilha";

import { readSwrCache, writeSwrCache } from "../swr-cache";

// Scroll memory per log pane (module scope — survives re-renders without
// reactive churn). Pinned-to-bottom follows the tail; scrolled-up stays put.
const logScroll = new Map<string, { stick: boolean; top: number }>();

const rememberScroll = (key: string, el: HTMLPreElement) => {
  logScroll.set(key, {
    stick: el.scrollHeight - el.scrollTop - el.clientHeight < 24,
    top: el.scrollTop,
  });
};

const restoreScroll = (paneId: string, key: string) => {
  const el = document.querySelector(`#${paneId}`);
  if (!(el instanceof HTMLPreElement)) {
    return;
  }
  const saved = logScroll.get(key);
  el.scrollTop = saved && !saved.stick ? saved.top : el.scrollHeight;
};

/**
 * Live tail of the running celld fleet's stdout/stderr (bounded buffer on the
 * runner). Streams SSE and only rerenders when the snapshot actually changes —
 * the buffer resets on runner restart, so this is recent activity only.
 */
export const RuntimeLogs = ({
  appId,
  logId = "runtime-logs",
}: {
  appId: string;
  logId?: string;
}) => {
  // Cache-first like the rest: last snapshot paints instantly on every
  // mount (including reloads), then the live stream takes over.
  // logId scopes concurrent panes (one per open deployment row).
  const key = `${appId}:${logId}`;
  const lines = atom<string[]>(
    readSwrCache<string[]>(`app:${appId}:logs`) ?? []
  );
  const loadError = atom("");

  watch.once(() => {
    if (lines().length > 0) {
      window.requestAnimationFrame(() => {
        restoreScroll(logId, key);
      });
    }
    let stopped = false;
    const source = new EventSource(
      `/api/apps/${encodeURIComponent(appId)}/logs/stream`
    );
    source.addEventListener("message", (event) => {
      try {
        const next: unknown = JSON.parse(event.data);
        if (!Array.isArray(next)) {
          return;
        }
        if (JSON.stringify(lines()) === JSON.stringify(next)) {
          return;
        }
        // SAFETY: the runner log stream emits string arrays; the array shape
        // is checked above and entries flow only into text rendering.
        lines.set(next as string[]);
        writeSwrCache(`app:${appId}:logs`, next);
        loadError.set("");
        window.requestAnimationFrame(() => {
          restoreScroll(logId, key);
        });
      } catch {
        loadError.set("Log stream sent invalid data");
      }
    });
    source.addEventListener("error", () => {
      if (!stopped) {
        loadError.set("Log stream disconnected — retrying…");
      }
    });
    return () => {
      stopped = true;
      source.close();
    };
  });

  return (
    <div class="flex flex-col gap-2">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      {lines().length === 0 && !loadError() ? (
        <p class="m-0 text-sm opacity-70">
          No output yet from the running fleet.
        </p>
      ) : (
        <pre
          id={logId}
          class="max-h-64 overflow-auto rounded font-mono text-xs whitespace-pre-wrap"
          onscroll={(e) => {
            const target = e.currentTarget;
            if (target instanceof HTMLPreElement) {
              rememberScroll(key, target);
            }
          }}
        >
          {lines().join("\n")}
        </pre>
      )}
    </div>
  );
};
