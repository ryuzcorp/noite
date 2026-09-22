//! Per-app event feed (LogSnag-style): channel filter, insight widgets,
//! expandable rows with tags + user properties, and an ingest snippet.
import { atom, watch } from "ilha";

import { formatDateTime } from "../dates";
import {
  getUserProps,
  listEventChannels,
  listEvents,
  listInsights,
} from "../events.server";
import type { RunnerEvent, RunnerInsight } from "../runner";

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
    <li class="border-base-300 border-b py-2 last:border-0">
      <button
        type="button"
        class="flex w-full items-center gap-3 text-left"
        onclick={onToggle}
        aria-expanded={expanded}
      >
        <span class="w-6 shrink-0 text-center text-lg" aria-hidden="true">
          {event.icon || "•"}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{event.event}</span>
          <span class="block truncate text-xs opacity-60">
            {event.channel}
            {event.userId ? ` · ${event.userId}` : ""} ·{" "}
            {formatDateTime(event.ts)}
          </span>
        </span>
      </button>
      {expanded ? (
        <div class="mt-2 flex flex-col gap-2 pl-9 text-sm">
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
    </li>
  );
};
/** Control origin for the ingest snippet (SSR-safe fallback for previews). */
const controlOrigin = (): string =>
  typeof window === "undefined"
    ? "https://app.example.com"
    : window.location.origin;

export const EventsPanel = ({ appId }: { appId: string }) => {
  const events = atom<RunnerEvent[]>([]);
  const channels = atom<string[]>([]);
  const insights = atom<RunnerInsight[]>([]);
  const channel = atom("");
  const expanded = atom<string | null>(null);
  const profiles = atom<Record<string, string>>({});
  const profileError = atom<Record<string, string>>({});
  const err = atom("");
  const loaded = atom(false);
  const busy = atom(false);

  const reload = async (ch = channel()) => {
    busy.set(true);
    try {
      // NOTE: never pass explicit `undefined` in action args — the RPC
      // client requires JSON values and rejects the whole call otherwise.
      const feedArgs = ch
        ? { appId, channel: ch, limit: 50 }
        : { appId, limit: 50 };
      const [feed, chans, widgets] = await Promise.all([
        listEvents(feedArgs),
        listEventChannels(appId),
        listInsights(appId),
      ]);
      events.set(feed);
      channels.set(chans);
      insights.set(widgets);
      err.set("");
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
      loaded.set(true);
    }
  };

  watch.once(() => {
    void reload();
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

  const snippet = () =>
    `curl -X POST ${controlOrigin()}/api/apps/${appId}/ingest/events \\
  -H "Authorization: Bearer noite_..." \\
  -H "Content-Type: application/json" \\
  -d '{"channel": "billing", "event": "Payment received", "icon": "💰",
       "tags": {"plan": "premium"}, "user_id": "123"}'`;

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
            <h3 class="m-0 text-lg font-semibold">Events</h3>
            <span class="flex items-center gap-2">
              <select
                class="select select-sm w-36"
                aria-label="Filter by channel"
                disabled={busy()}
                onchange={(e) => {
                  // SAFETY: ilha onchange currentTarget is the <select> that fired.
                  const next = (e.currentTarget as HTMLSelectElement).value;
                  channel.set(next);
                  expanded.set(null);
                  void reload(next);
                }}
              >
                <option value="">All channels</option>
                {channels().map((c) => (
                  <option value={c} selected={channel() === c}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  void reload();
                }}
              >
                {busy() ? "Loading…" : "Refresh"}
              </button>
            </span>
          </div>
          {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
          {loaded() && events().length === 0 && !err() ? (
            <p class="m-0 text-sm opacity-70">
              No events yet — publish one with the snippet below.
            </p>
          ) : null}
          {events().length > 0 ? (
            <ul class="m-0 flex list-none flex-col gap-1 p-0">
              {events().map((event) => (
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
        </div>
      </section>
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
            {snippet()}
          </pre>
        </div>
      </section>
    </div>
  );
};
