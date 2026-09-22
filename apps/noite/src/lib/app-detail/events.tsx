//! Per-app event feed (LogSnag-style): channel filter, insight widgets,
//! expandable rows with tags + user properties, and an ingest snippet.
import { navigate, useRoute } from "@ilha/router";
import { atom, unsafe, watch } from "ilha";

import { CHEVRON_DOWN_SVG } from "../apps";
import { formatDateTime } from "../dates";
import { getUserProps } from "../events.server";
import type { RunnerEvent, RunnerInsight } from "../runner";
import { readSwrCache, writeSwrCache } from "../swr-cache";

const parseTags = (raw: string): [string, string][] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt tags never break the feed; the row just shows none.
    return [];
  }
  if (!parsed || Array.isArray(parsed)) {
    return [];
  }
  // SAFETY: the runner validates tag maps at ingest (string|number|boolean
  // values); anything else degrades to String() display below, and null is
  // excluded above so entries() cannot throw.
  const obj = parsed as Record<string, string | number | boolean>;
  return Object.entries(obj).map(([k, v]) => [k, String(v)]);
};

/** Expanded-row profile line: warning, loading, empty, or raw properties. */
const profileStatus = (props: string | null, propsError: string) => {
  if (propsError) {
    return <span class="text-warning">{propsError}</span>;
  }
  if (props === null) {
    return "Loading profile…";
  }
  if (props === "") {
    return "No profile properties.";
  }
  return <span class="font-mono">{props}</span>;
};
/** Event feed row (daisyUI list-row, like the storage inventory): icon,
 * name + subline, expand chevron; details stack in the content column. */
const EventRow = ({
  event,
  expanded,
  onToggle,
  props,
  propsError,
}: {
  event: RunnerEvent;
  expanded: boolean;
  onToggle: () => void;
  props: string | null;
  propsError: string;
}) => {
  const tags = parseTags(event.tags);
  return (
    <li class="list-row">
      <div>
        <span class="text-lg" aria-hidden="true">
          {event.icon || "•"}
        </span>
      </div>
      <div class="min-w-0 flex-1">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 text-left"
          onclick={onToggle}
          aria-expanded={expanded}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">
              {event.event}
            </span>
            <span class="block truncate text-xs opacity-60">
              {event.channel}
              {event.userId ? ` · ${event.userId}` : ""} ·{" "}
              {formatDateTime(event.ts)}
            </span>
          </span>
          <span
            class={`inline-flex h-5 w-5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            {unsafe(CHEVRON_DOWN_SVG)}
          </span>
        </button>
        {expanded ? (
          <div class="mt-2 flex flex-col gap-2 text-sm">
            {event.description ? (
              <p class="m-0 text-sm whitespace-pre-wrap opacity-90">
                {event.description}
              </p>
            ) : null}
            {tags.length > 0 ? (
              <div class="flex flex-wrap gap-1">
                {tags.map(([k, v]) => (
                  <span key={k} class="badge badge-ghost badge-sm font-mono">
                    {k}={v}
                  </span>
                ))}
              </div>
            ) : null}
            {event.userId ? (
              <div class="text-xs opacity-70">
                {profileStatus(props, propsError)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
};
/** Control origin for the ingest snippet (SSR-safe fallback for previews). */
const controlOrigin = (): string =>
  typeof window === "undefined"
    ? "https://app.example.com"
    : window.location.origin;
/** Page-size options (same set as the D1 browser) + feed fetch cap. */
const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 10;
const FEED_LIMIT = 200;
/** Seed filter/paging state from the URL (refresh + tab switches restore). */
const readEventSeeds = (search: string) => {
  const params = new URLSearchParams(search);
  const parsedSize = Math.trunc(Number(params.get("s") ?? ""));
  return {
    pageIndex: Math.max(Math.trunc(Number(params.get("p") ?? "")) || 0, 0),
    pageSize: [10, 25, 50, 100].includes(parsedSize)
      ? parsedSize
      : DEFAULT_PAGE_SIZE,
    query: params.get("q") ?? "",
  };
};

/** Case-insensitive substring over the rendered row fields (D1 includesString). */
const filterEvents = (all: RunnerEvent[], rawQuery: string): RunnerEvent[] => {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return all;
  }
  return all.filter((event) =>
    [
      event.channel,
      event.event,
      event.description,
      event.icon,
      event.tags,
      event.userId,
    ].some((field) => field.toLowerCase().includes(q))
  );
};

const eventPageCount = (matched: number, size: number): number =>
  Math.max(Math.ceil(matched / size), 1);

const pageSlice = (
  matched: RunnerEvent[],
  size: number,
  index: number
): RunnerEvent[] => {
  const start = index * size;
  return matched.slice(start, start + size);
};
/** Runner events-stream snapshot (same rows as the list endpoints). */
interface EventsSnapshot {
  channels: string[];
  feed: RunnerEvent[];
  insights: RunnerInsight[];
}
/** Ingest snippet card, shown only before the first event lands. */
const SendEventsCard = ({
  appId,
  visible,
}: {
  appId: string;
  visible: boolean;
}) => {
  if (!visible) {
    return null;
  }
  const snippet = `curl -X POST ${controlOrigin()}/api/apps/${appId}/ingest/events \\
  -H "Authorization: Bearer noite_..." \\
  -H "Content-Type: application/json" \\
  -d '{"channel": "billing", "event": "Payment received", "icon": "💰",
       "tags": {"plan": "premium"}, "user_id": "123"}'`;
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-2">
        <h3 class="m-0 text-lg font-semibold">Send events</h3>
        <p class="m-0 text-sm opacity-70">
          Server-to-server ingest with a profile API key (Profile → API keys).
          The key needs push access on this app plus the Events scope — an
          Events-only key can't push code or manage anything. Also accepts{" "}
          <code>/identify</code> (user properties) and <code>/insights</code>{" "}
          (set, or{" "}
          <code>
            {"{"}$inc{"}"}
          </code>{" "}
          to increment).
        </p>
        <pre class="bg-base-300 overflow-x-auto rounded p-3 font-mono text-xs">
          {snippet}
        </pre>
      </div>
    </section>
  );
};

/** Feed pager (D1-style): page steppers + rows-per-page. */
const EventsPager = ({
  onNext,
  onPrev,
  onSize,
  page,
  pages,
  size,
  visible,
}: {
  onNext: () => void;
  onPrev: () => void;
  onSize: (n: number) => void;
  page: number;
  pages: number;
  size: number;
  visible: boolean;
}) => {
  if (!visible) {
    return null;
  }
  return (
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="m-0 text-sm opacity-70">
        Page {page + 1} of {pages}
      </p>
      <span class="flex items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          disabled={page === 0}
          onclick={onPrev}
        >
          ‹ Prev
        </button>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          disabled={page >= pages - 1}
          onclick={onNext}
        >
          Next ›
        </button>
        <select
          class="select select-sm w-20"
          aria-label="Rows per page"
          onchange={(e) => {
            const el = e.currentTarget;
            if (el instanceof HTMLSelectElement) {
              onSize(Number(el.value));
            }
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option value={n} selected={size === n}>
              {n}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
};

export const EventsPanel = ({ appId }: { appId: string }) => {
  const route = useRoute();
  // Channel lives in ?channel= (like ?t= for tabs) so refresh and tab
  // switches restore the filter; unknown values just yield an empty feed.
  const channel = atom(
    new URLSearchParams(route.search()).get("channel") ?? ""
  );
  const snapshotKey = (ch: string): string => `app:${appId}:events:${ch}`;
  const seed = readSwrCache<EventsSnapshot>(snapshotKey(channel()));
  const events = atom<RunnerEvent[]>(seed?.feed ?? []);
  const channels = atom<string[]>(seed?.channels ?? []);
  const insights = atom<RunnerInsight[]>(seed?.insights ?? []);
  const expanded = atom<string | null>(null);
  const profiles = atom<Record<string, string>>({});
  const profileError = atom<Record<string, string>>({});
  const err = atom("");
  const loaded = atom(seed !== null);
  // Text filter + pagination mirror the D1 browser: client-side over the
  // fetched feed, deep-linkable via ?q=/?p=/?s= (replaceState, no remount).
  const seeds = readEventSeeds(route.search());
  const query = atom(seeds.query);
  const pageIndex = atom(seeds.pageIndex);
  const pageSize = atom(seeds.pageSize);

  const syncUrl = () => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const set = (key: string, value: string) => {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    };
    set("q", query());
    set("p", pageIndex() > 0 ? String(pageIndex()) : "");
    set("s", pageSize() === DEFAULT_PAGE_SIZE ? "" : String(pageSize()));
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      next ? `${window.location.pathname}?${next}` : window.location.pathname
    );
  };

  const applySnapshot = (ch: string, snapshot: EventsSnapshot): void => {
    events.set(snapshot.feed);
    channels.set(snapshot.channels);
    insights.set(snapshot.insights);
    writeSwrCache(snapshotKey(ch), snapshot);
    err.set("");
  };

  // Live feed over SSE (like DeployList): the runner pushes a combined
  // snapshot on change; resubscribe re-scopes ?channel= server-side.
  let source: EventSource | null = null;
  const connect = (ch: string) => {
    source?.close();
    const cached = readSwrCache<EventsSnapshot>(snapshotKey(ch));
    if (cached) {
      applySnapshot(ch, cached);
      loaded.set(true);
    }
    const params = new URLSearchParams();
    if (ch) {
      params.set("channel", ch);
    }
    params.set("limit", String(FEED_LIMIT));
    const next = new EventSource(
      `/api/apps/${encodeURIComponent(appId)}/events/stream?${params.toString()}`
    );
    source = next;
    next.addEventListener("message", (event) => {
      // A frame arrived, so the stream is alive — even when the payload
      // matches, it clears a stale disconnect notice.
      loaded.set(true);
      try {
        const data: unknown = JSON.parse(event.data);
        // SAFETY: field arrays verified below; the runner emits list rows.
        const snapshot = data as Partial<EventsSnapshot>;
        if (
          !Array.isArray(snapshot.feed) ||
          !Array.isArray(snapshot.channels) ||
          !Array.isArray(snapshot.insights)
        ) {
          err.set("Events stream sent invalid data");
          return;
        }
        // SAFETY: all three field arrays verified above.
        applySnapshot(ch, snapshot as EventsSnapshot);
      } catch {
        err.set("Events stream sent invalid data");
      }
    });
    next.addEventListener("error", () => {
      loaded.set(true);
      err.set("Events stream disconnected — retrying…");
    });
  };

  watch.once(() => {
    connect(channel());
    return () => {
      source?.close();
      source = null;
    };
  });

  const toggle = (event: RunnerEvent) => {
    const open = expanded() === event.id ? null : event.id;
    expanded.set(open);
    if (open && event.userId && !(event.userId in profiles())) {
      void (async () => {
        try {
          const row = await getUserProps({ appId, userId: event.userId });
          profiles.set({
            ...profiles(),
            [event.userId]: row?.properties ?? "",
          });
        } catch (error) {
          profileError.set({
            ...profileError(),
            [event.userId]:
              error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }
  };
  const matchedEvents = (): RunnerEvent[] => filterEvents(events(), query());
  const pageCount = (): number =>
    eventPageCount(matchedEvents().length, pageSize());
  const safePage = (): number => Math.min(pageIndex(), pageCount() - 1);
  const pageEvents = (): RunnerEvent[] =>
    pageSlice(matchedEvents(), pageSize(), safePage());
  const resetFilters = () => {
    query.set("");
    pageIndex.set(0);
    const el = document.querySelector("#events-search");
    if (el instanceof HTMLInputElement) {
      el.value = "";
    }
    syncUrl();
  };

  return (
    <div class="flex flex-col gap-4">
      {insights().length > 0 ? (
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {insights().map((w) => (
            <section
              key={w.title}
              class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md"
            >
              <div class="card-body gap-1 p-4">
                <p class="m-0 text-xs opacity-70">
                  {w.icon ? `${w.icon} ` : ""}
                  {w.title}
                </p>
                <p class="m-0 font-mono text-2xl font-semibold">{w.value}</p>
              </div>
            </section>
          ))}
        </div>
      ) : null}
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="flex items-center gap-2 tracking-wide">
              <h3 class="m-0 text-lg font-semibold">Events</h3>
              <span class="badge badge-sm">{events().length}</span>
            </span>
            <span class="flex items-center gap-2">
              <input
                id="events-search"
                class="input input-sm w-44"
                type="search"
                placeholder="Filter events…"
                aria-label="Filter events by text"
                value={query()}
                onchange={(e) => {
                  const el = e.currentTarget;
                  if (el instanceof HTMLInputElement) {
                    query.set(el.value);
                    pageIndex.set(0);
                    syncUrl();
                  }
                }}
              />
              <select
                class="select select-sm w-36"
                aria-label="Filter by channel"
                onchange={(e) => {
                  // SAFETY: ilha onchange currentTarget is the <select> that fired.
                  const next = (e.currentTarget as HTMLSelectElement).value;
                  channel.set(next);
                  expanded.set(null);
                  pageIndex.set(0);
                  // Fresh location, not the router snapshot: q/p/s sync via
                  // replaceState, which the router never sees.
                  const params = new URLSearchParams(window.location.search);
                  if (next) {
                    params.set("channel", next);
                  } else {
                    params.delete("channel");
                  }
                  const nextQuery = params.toString();
                  navigate(
                    nextQuery ? `${route.path()}?${nextQuery}` : route.path(),
                    { replace: true }
                  );
                  connect(next);
                }}
              >
                <option value="">All channels</option>
                {channels().map((c) => (
                  <option value={c} selected={channel() === c}>
                    {c}
                  </option>
                ))}
              </select>
            </span>
          </div>
          {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
          {loaded() && events().length > 0 && matchedEvents().length === 0 ? (
            <div class="flex flex-wrap items-center gap-2">
              <p class="m-0 text-sm opacity-70">No events match the filter.</p>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick={resetFilters}
              >
                Clear filter
              </button>
            </div>
          ) : null}
          {pageEvents().length > 0 ? (
            <ul class="list m-0 w-full p-0">
              {pageEvents().map((event) => (
                <EventRow
                  event={event}
                  expanded={expanded() === event.id}
                  onToggle={() => {
                    toggle(event);
                  }}
                  props={profiles()[event.userId] ?? null}
                  propsError={profileError()[event.userId] ?? ""}
                />
              ))}
            </ul>
          ) : null}
          <EventsPager
            visible={matchedEvents().length > pageSize()}
            page={safePage()}
            pages={pageCount()}
            size={pageSize()}
            onPrev={() => {
              pageIndex.set(safePage() - 1);
              syncUrl();
            }}
            onNext={() => {
              pageIndex.set(safePage() + 1);
              syncUrl();
            }}
            onSize={(n: number) => {
              pageSize.set(n);
              pageIndex.set(0);
              syncUrl();
            }}
          />
        </div>
      </section>
      <SendEventsCard
        appId={appId}
        visible={loaded() && events().length === 0}
      />
    </div>
  );
};
