//! Per-app event feed (LogSnag-style): channel filter, insight widgets,
//! expandable rows with tags + user properties, and an ingest snippet.
import { searchParam } from "@ilha/router";
import type { SearchParam } from "@ilha/router";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { formatDateTime } from "../dates";
import { getUserProps } from "../events.server";
import type { EventsSnapshot } from "../feeds";
import { decodeEvents, eventsUrl, feedKeys, liveFeed } from "../feeds";
import { ChevronDown } from "../icons";
import type { RunnerEvent } from "../runner";

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
            <ChevronDown size={20} />
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
/** Control origin for the ingest snippet. */
const controlOrigin = (): string => window.location.origin;
/** Page-size options (same set as the D1 browser) + feed fetch cap. */
const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 10;
const FEED_LIMIT = 200;
/** Parse `?p=` (page index): garbage falls back to the first page. */
const toPageIndex = (raw: string): number =>
  Math.max(Math.trunc(Number(raw)) || 0, 0);

/** Parse `?s=` (page size): unknown sizes fall back to the default. */
const toPageSize = (raw: string): number => {
  const n = Math.trunc(Number(raw));
  return PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
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
          Server-to-server ingest with an API key (Account → API keys). The key
          needs push access on this app plus the Events scope — an Events-only
          key can't push code or manage anything. Also accepts{" "}
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
            onSize(Number(e.currentTarget.value));
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

/** Live event feed for one channel, remounted (via `key`) whenever the
 * channel changes — so each channel gets its own connection and snapshot.
 * Filter/paging bindings live in the panel so they survive the remount. */
const EventsFeed = ({
  appId,
  channel,
  clearQuery,
  pageIndex,
  pageSize,
  query,
}: {
  appId: string;
  channel: SearchParam<string>;
  clearQuery: () => void;
  pageIndex: SearchParam<number>;
  pageSize: SearchParam<number>;
  query: AtomHandle<string>;
}) => {
  const feed = liveFeed(
    feedKeys.events(appId, channel()),
    eventsUrl(appId, channel(), FEED_LIMIT),
    decodeEvents
  );
  const snapshot = (): EventsSnapshot =>
    feed.latest() ?? { channels: [], feed: [], insights: [] };
  const loaded = (): boolean =>
    feed.latest() !== undefined || feed.status() === "open";
  const retrying = (): boolean => feed.status() === "retrying";
  const expanded = atom<string | null>(null);
  const profiles = atom<Record<string, string>>({});
  const profileError = atom<Record<string, string>>({});

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
  const matchedEvents = (): RunnerEvent[] =>
    filterEvents(snapshot().feed, query());
  const pageCount = (): number =>
    eventPageCount(matchedEvents().length, pageSize());
  const safePage = (): number => Math.min(pageIndex(), pageCount() - 1);
  const pageEvents = (): RunnerEvent[] =>
    pageSlice(matchedEvents(), pageSize(), safePage());
  return (
    <div class="flex flex-col gap-4">
      {snapshot().insights.length > 0 ? (
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {snapshot().insights.map((w) => (
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
              <span class="badge badge-sm">{snapshot().feed.length}</span>
            </span>
            <span class="flex items-center gap-2">
              <input
                id="events-search"
                class="input input-sm w-44"
                type="search"
                placeholder="Filter events…"
                aria-label="Filter events by text"
                value={query()}
                oninput={(e) => {
                  query.set(e.currentTarget.value);
                  pageIndex.set(0);
                }}
              />
              <select
                class="select select-sm w-36"
                aria-label="Filter by channel"
                onchange={(e) => {
                  channel.set(e.currentTarget.value);
                  pageIndex.set(0);
                }}
              >
                <option value="">All channels</option>
                {snapshot().channels.map((c) => (
                  <option value={c} selected={channel() === c}>
                    {c}
                  </option>
                ))}
              </select>
            </span>
          </div>
          {retrying() ? (
            <p class="text-error m-0 text-sm">
              Events stream disconnected — retrying…
            </p>
          ) : null}
          {loaded() &&
          snapshot().feed.length > 0 &&
          matchedEvents().length === 0 ? (
            <div class="flex flex-wrap items-center gap-2">
              <p class="m-0 text-sm opacity-70">No events match the filter.</p>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick={clearQuery}
              >
                Clear filter
              </button>
            </div>
          ) : null}
          {pageEvents().length > 0 ? (
            <ul class="list m-0 w-full p-0">
              {pageEvents().map((event) => (
                <EventRow
                  key={event.id}
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
            }}
            onNext={() => {
              pageIndex.set(safePage() + 1);
            }}
            onSize={(n: number) => {
              pageSize.set(n);
              pageIndex.set(0);
            }}
          />
        </div>
      </section>
      <SendEventsCard
        appId={appId}
        visible={loaded() && snapshot().feed.length === 0}
      />
    </div>
  );
};

export const EventsPanel = ({ appId }: { appId: string }) => {
  // Channel + paging live in the URL (like ?t= for tabs) so refresh and
  // tab switches restore them; unknown channels just yield an empty feed.
  // Writing a default removes the param, matching the old URLs.
  const channel = searchParam("channel", { default: "" });
  const q = searchParam("q", { default: "" });
  const pageIndex = searchParam("p", { default: 0, parse: toPageIndex });
  const pageSize = searchParam("s", {
    default: DEFAULT_PAGE_SIZE,
    parse: toPageSize,
  });
  // Text filter drafts locally and commits to the URL debounced, so typing
  // never waits on navigation.
  const query = atom(q());
  const committed = atom(q());
  watch(query, (value, { signal }) => {
    // watch() also fires once on mount; committing then would reset a
    // deep-linked ?p= to page 0. Only commit real edits.
    if (value === committed()) {
      return;
    }
    const timer = setTimeout(() => {
      if (!signal.aborted && query() === value) {
        committed.set(value);
        q.set(value);
        pageIndex.set(0);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  });
  // Back/forward moved the URL without us — adopt it into the draft.
  if (q() !== committed()) {
    committed.set(q());
    query.set(q());
  }
  const clearQuery = () => {
    committed.set("");
    query.set("");
    q.set("");
    pageIndex.set(0);
  };
  return (
    <EventsFeed
      key={channel()}
      appId={appId}
      channel={channel}
      clearQuery={clearQuery}
      pageIndex={pageIndex}
      pageSize={pageSize}
      query={query}
    />
  );
};
