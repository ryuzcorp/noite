//! Errors tab: exceptions from celld telemetry grouped into issues by the
//! runner (`host/errors.rs`) — no SDK in the app. List by status, detail
//! with stack, request and the failing trace's logs; anyone who can push
//! resolves, ignores or reopens.
import { navigate, searchParam } from "@ilha/router";
import { atom } from "ilha";

import { setErrorStatus } from "../apps.server";
import { formatAgo, formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { decodeErrors, errorsUrl, feedKeys, liveFeed } from "../feeds";
import { ArrowLeft } from "../icons";
import { LoadError } from "../load-error";
import { appDetail, errorDetail } from "../resources";
import type {
  ErrorStatus,
  RunnerErrorEvent,
  RunnerErrorFrame,
  RunnerErrorIssue,
  RunnerErrorList,
} from "../runner";
import { ListSkeleton, SectionSkeleton } from "../skeletons";

const STATUSES: { id: ErrorStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "ignored", label: "Ignored" },
];

const toStatus = (raw: string): ErrorStatus =>
  STATUSES.find((s) => s.id === raw)?.id ?? "open";

const US_PER_MS = 1000;
const DAY_MS = 86_400_000;
const SHA_CHARS = 7;

const usToDate = (us: number): Date => new Date(us / US_PER_MS);

/** celld span name (minus `celld.`) → what an app author calls it. */
const HANDLER_LABELS = new Map([
  ["alarm", "Alarm"],
  ["cell_fetch", "Durable Object"],
  ["fetch", "Request"],
  ["queue", "Queue"],
  ["rpc", "RPC"],
  ["scheduled", "Cron"],
]);

const handlerLabel = (handler: string, source: string): string => {
  if (source === "logged") {
    return "console.error";
  }
  return HANDLER_LABELS.get(handler) ?? handler;
};

/** `Counter:ed7a…` → `Counter`: the class, not the (long) cell id. */
const cellClass = (cell: string): string => cell.split(":")[0] ?? cell;

const shortSha = (sha: string | null): string =>
  sha ? sha.slice(0, SHA_CHARS) : "";

/** 24 hourly bars, oldest first; scaled to the busiest hour. */
const Sparkline = ({
  hourly,
  tall = false,
}: {
  hourly: number[];
  tall?: boolean;
}) => {
  const peak = Math.max(1, ...hourly);
  const total = hourly.reduce((sum, n) => sum + n, 0);
  return (
    <span
      class={`flex items-end gap-px ${tall ? "h-10 w-48" : "h-6 w-24"}`}
      title={`${total} in the last 24 hours`}
      role="img"
      aria-label={`${total} occurrences in the last 24 hours`}
    >
      {hourly.map((n, i) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- fixed 24-slot series; the slot index is the identity
          key={i}
          class={`flex-1 rounded-sm ${n > 0 ? "bg-error/70" : "bg-base-300"}`}
          style={`height: ${n > 0 ? Math.max(12, (n / peak) * 100) : 6}%`}
        />
      ))}
    </span>
  );
};

const IssueBadges = ({ issue }: { issue: RunnerErrorIssue }) => {
  const isNew = Date.now() - issue.firstSeenUs / US_PER_MS < DAY_MS;
  return (
    <>
      <span class="badge badge-ghost badge-sm">
        {handlerLabel(issue.handler, issue.source)}
      </span>
      {issue.regressed ? (
        <span class="badge badge-warning badge-sm">Regressed</span>
      ) : null}
      {isNew && !issue.regressed ? (
        <span class="badge badge-info badge-sm">New</span>
      ) : null}
    </>
  );
};

const IssueRow = ({
  issue,
  onPick,
}: {
  issue: RunnerErrorIssue;
  onPick: () => void;
}) => (
  <li class="list-row">
    <button
      type="button"
      class="col-span-full flex w-full min-w-0 items-center gap-4 text-left"
      onclick={onPick}
    >
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm">
          <span class="font-semibold">{issue.kind}</span>
          <span class="opacity-80">: {issue.message}</span>
        </span>
        <span class="mt-1 flex flex-wrap items-center gap-1 text-xs opacity-70">
          {issue.culprit ? (
            <span class="mr-1 truncate font-mono">{issue.culprit}</span>
          ) : null}
          <IssueBadges issue={issue} />
        </span>
      </span>
      <span class="hidden shrink-0 sm:block">
        <Sparkline hourly={issue.hourly} />
      </span>
      <span class="w-24 shrink-0 text-right">
        <span class="block text-sm font-semibold tabular-nums">
          {issue.count.toLocaleString()}
        </span>
        <span class="block text-xs opacity-60">
          {formatAgo(usToDate(issue.lastSeenUs))}
        </span>
      </span>
    </button>
  </li>
);

/** Live issue list for one status over SSE: the last snapshot (or a
 * skeleton when cold) until the first frame, then the runner pushes a frame
 * whenever the list, a count or a sparkline moves — no refresh button. */
export const liveErrors = (appId: string, status: ErrorStatus) => {
  const feed = liveFeed(
    feedKeys.errors(appId, status),
    errorsUrl(appId, status),
    decodeErrors
  );
  const data = (): RunnerErrorList | undefined => feed.latest();
  const retrying = (): boolean => feed.status() === "retrying";
  return {
    data,
    pending: (): boolean => data() === undefined && !retrying(),
    retrying,
  };
};

const StreamRetrying = () => (
  <p class="text-error m-0 text-sm">Error stream disconnected — retrying…</p>
);

const EmptyErrors = ({ status }: { status: ErrorStatus }) => {
  if (status !== "open") {
    return (
      <p class="m-0 py-6 text-center text-sm opacity-70">No {status} errors.</p>
    );
  }
  return (
    <div class="flex flex-col gap-1 py-6 text-center">
      <p class="m-0 text-sm font-medium">No open errors</p>
      <p class="m-0 text-sm opacity-70">
        Uncaught exceptions and <code>console.error(err)</code> calls that carry
        a stack show up here within about a minute. No SDK needed.
      </p>
    </div>
  );
};

const ErrorList = ({
  appId,
  onPick,
  onStatus,
  status,
}: {
  appId: string;
  onPick: (fingerprint: string) => void;
  onStatus: (status: ErrorStatus) => void;
  status: ErrorStatus;
}) => {
  const live = liveErrors(appId, status);
  const data = live.data();
  const issues = data?.issues ?? [];
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-3">
        <h2 class="m-0 text-lg font-semibold">Errors</h2>
        <div class="overflow-x-auto">
          <div role="tablist" class="tabs tabs-box tabs-sm w-fit flex-nowrap">
            {STATUSES.map((s) => (
              <button
                type="button"
                role="tab"
                aria-selected={status === s.id ? "true" : "false"}
                class={`tab ${status === s.id ? "tab-active" : ""}`}
                onclick={() => {
                  onStatus(s.id);
                }}
              >
                {s.label}
                {data ? (
                  <span class="ml-1 tabular-nums opacity-60">
                    {data.counts[s.id]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        {live.retrying() ? <StreamRetrying /> : null}
        {live.pending() ? <ListSkeleton rows={4} /> : null}
        {data !== undefined && issues.length === 0 ? (
          <EmptyErrors status={status} />
        ) : null}
        {issues.length > 0 ? (
          <ul class="list m-0 w-full p-0">
            {issues.map((issue) => (
              <IssueRow
                key={issue.fingerprint}
                issue={issue}
                onPick={() => {
                  onPick(issue.fingerprint);
                }}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
};

const FrameLine = ({ frame }: { frame: RunnerErrorFrame }) => (
  <li
    class={`flex flex-wrap gap-x-2 px-3 py-1 font-mono text-xs ${frame.inApp ? "" : "opacity-50"}`}
  >
    <span class={frame.inApp ? "font-semibold" : ""}>
      {frame.function || "<anonymous>"}
    </span>
    <span class="opacity-70">{frame.location}</span>
  </li>
);

const RequestLine = ({ event }: { event: RunnerErrorEvent }) => {
  if (!event.path) {
    return <span class="opacity-60">No request context</span>;
  }
  const device = [event.browser, event.os].filter(Boolean).join(" · ");
  return (
    <span class="font-mono">
      {event.method} {event.path}
      {event.httpStatus ? (
        <span
          class={event.httpStatus >= 500 ? "text-error" : "opacity-70"}
        >{` → ${event.httpStatus}`}</span>
      ) : null}
      {device ? <span class="opacity-60">{` · ${device}`}</span> : null}
    </span>
  );
};

const Occurrence = ({ event }: { event: RunnerErrorEvent }) => (
  <div class="flex flex-col gap-3">
    <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="opacity-60">When</dt>
      <dd class="m-0">
        {formatDateTime(usToDate(event.tsUs))}
        {event.sha ? (
          <span class="font-mono opacity-60">{` · ${shortSha(event.sha)}`}</span>
        ) : null}
      </dd>
      <dt class="opacity-60">Request</dt>
      <dd class="m-0 min-w-0 break-all">
        <RequestLine event={event} />
      </dd>
      <dt class="opacity-60">Handler</dt>
      <dd class="m-0">
        {handlerLabel(event.handler, event.source)}
        {event.cell ? (
          <span class="font-mono opacity-70">{` · ${cellClass(event.cell)}`}</span>
        ) : null}
      </dd>
      {event.context ? (
        <>
          <dt class="opacity-60">Logged as</dt>
          <dd class="m-0 font-mono break-all">{event.context}</dd>
        </>
      ) : null}
      {event.traceId ? (
        <>
          <dt class="opacity-60">Trace</dt>
          <dd class="m-0 font-mono text-xs break-all opacity-70">
            {event.traceId}
          </dd>
        </>
      ) : null}
    </dl>
    <div class="flex flex-col gap-1">
      <h3 class="m-0 text-sm font-semibold">Stack trace</h3>
      <p class="m-0 font-mono text-sm break-words whitespace-pre-wrap">
        <span class="font-semibold">{event.kind}</span>: {event.message}
      </p>
      {event.frames.length > 0 ? (
        <ol class="bg-base-200 dark:bg-base-300 m-0 list-none rounded py-2 pl-0">
          {event.frames.map((frame, i) => (
            <FrameLine
              // oxlint-disable-next-line react/no-array-index-key -- stack frames repeat (recursion); position is the identity
              key={i}
              frame={frame}
            />
          ))}
        </ol>
      ) : (
        <p class="m-0 text-xs opacity-60">No stack captured.</p>
      )}
    </div>
    {event.logs.length > 0 ? (
      <div class="flex flex-col gap-1">
        <h3 class="m-0 text-sm font-semibold">Logs from this request</h3>
        <pre class="bg-base-300 m-0 overflow-x-auto rounded p-3 font-mono text-xs">
          {event.logs.join("\n")}
        </pre>
      </div>
    ) : null}
  </div>
);

const TriageButtons = ({
  appId,
  issue,
  onDone,
}: {
  appId: string;
  issue: RunnerErrorIssue;
  onDone: () => Promise<void>;
}) => {
  const busy = atom(false);
  const failure = atom("");
  const apply = async (status: ErrorStatus) => {
    busy.set(true);
    failure.set("");
    try {
      await setErrorStatus({ appId, fingerprint: issue.fingerprint, status });
      await onDone();
    } catch (error) {
      failure.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };
  return (
    <div class="flex flex-col items-end gap-1">
      <div class="flex gap-2">
        {issue.status === "open" ? (
          <>
            <button
              type="button"
              class="btn btn-sm"
              disabled={busy()}
              onclick={() => apply("ignored")}
            >
              Ignore
            </button>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={busy()}
              onclick={() => apply("resolved")}
            >
              Resolve
            </button>
          </>
        ) : (
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy()}
            onclick={() => apply("open")}
          >
            Reopen
          </button>
        )}
      </div>
      {failure() ? <span class="text-error text-xs">{failure()}</span> : null}
    </div>
  );
};

const statusNote = (issue: RunnerErrorIssue): string => {
  if (issue.status === "resolved") {
    return "Resolved — reopens if it happens again.";
  }
  if (issue.status === "ignored") {
    return "Ignored — still counted, never reopened.";
  }
  return "";
};

const ErrorDetailView = ({
  appId,
  canTriage,
  fingerprint,
  onBack,
}: {
  appId: string;
  canTriage: boolean;
  fingerprint: string;
  onBack: () => void;
}) => {
  const res = errorDetail(appId, fingerprint);
  const picked = atom(0);
  const data = res.data();
  const back = (
    <button
      type="button"
      class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
      onclick={onBack}
    >
      <ArrowLeft />
      All errors
    </button>
  );
  if (res.loading() && data === undefined) {
    return (
      <div class="flex flex-col gap-3">
        {back}
        <SectionSkeleton lines={6} />
      </div>
    );
  }
  if (!data) {
    return (
      <div class="flex flex-col gap-3">
        {back}
        <LoadError error={res.error()} />
      </div>
    );
  }
  const { events, issue } = data;
  const index = Math.min(picked(), Math.max(0, events.length - 1));
  const event = events[index];
  // The lists are live; only this detail view needs a re-read.
  const refresh = async () => {
    await res.refetch();
  };
  const note = statusNote(issue);
  return (
    <div class="flex flex-col gap-4">
      {back}
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="m-0 text-lg font-semibold break-words">
                {issue.kind}
                <span class="font-normal opacity-80">: {issue.message}</span>
              </h2>
              <p class="m-0 mt-1 flex flex-wrap items-center gap-1 text-xs opacity-70">
                {issue.culprit ? (
                  <span class="mr-1 font-mono">{issue.culprit}</span>
                ) : null}
                <IssueBadges issue={issue} />
              </p>
            </div>
            {canTriage ? (
              <TriageButtons appId={appId} issue={issue} onDone={refresh} />
            ) : null}
          </div>
          {note ? <p class="m-0 text-sm opacity-70">{note}</p> : null}
          <div class="flex flex-wrap items-end gap-6">
            <div>
              <div class="text-xs opacity-60">Events</div>
              <div class="text-lg font-semibold tabular-nums">
                {issue.count.toLocaleString()}
              </div>
            </div>
            <div>
              <div class="text-xs opacity-60">First seen</div>
              <div class="text-sm">
                {formatAgo(usToDate(issue.firstSeenUs))}
                {issue.firstSha ? (
                  <span class="font-mono opacity-60">{` · ${shortSha(issue.firstSha)}`}</span>
                ) : null}
              </div>
            </div>
            <div>
              <div class="text-xs opacity-60">Last seen</div>
              <div class="text-sm">
                {formatAgo(usToDate(issue.lastSeenUs))}
                {issue.lastSha ? (
                  <span class="font-mono opacity-60">{` · ${shortSha(issue.lastSha)}`}</span>
                ) : null}
              </div>
            </div>
            <div>
              <div class="text-xs opacity-60">Last 24 hours</div>
              <Sparkline hourly={issue.hourly} tall />
            </div>
          </div>
        </div>
      </section>
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="m-0 text-base font-semibold">
              {index === 0 ? "Latest occurrence" : "Occurrence"}
            </h2>
            {events.length > 1 ? (
              <span class="flex items-center gap-2">
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={index === 0}
                  onclick={() => {
                    picked.set(index - 1);
                  }}
                >
                  ‹ Newer
                </button>
                <span class="text-sm tabular-nums opacity-70">
                  {index + 1} of {events.length}
                </span>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={index >= events.length - 1}
                  onclick={() => {
                    picked.set(index + 1);
                  }}
                >
                  Older ›
                </button>
              </span>
            ) : null}
          </div>
          {event ? (
            <Occurrence event={event} />
          ) : (
            <p class="m-0 text-sm opacity-70">
              No stored occurrences (older ones age out with telemetry
              retention).
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

const SUMMARY_ISSUES = 3;

/** Overview card: the most recent open errors, linking into the tab. Live
 * like the tab's list, and shares its `open` snapshot, so either paints
 * instantly once the other has loaded. */
export const ErrorsSummary = ({ appId }: { appId: string }) => {
  const live = liveErrors(appId, "open");
  const data = live.data();
  const issues = (data?.issues ?? []).slice(0, SUMMARY_ISSUES);
  const open = data?.counts.open ?? 0;
  const tabHref = `/apps/${appId}?t=errors`;
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-3">
        <div class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-2">
            <h2 class="m-0 text-lg font-semibold">Errors</h2>
            {data ? <span class="badge badge-sm">{open}</span> : null}
          </span>
          <a href={tabHref} class="btn btn-sm">
            View All
          </a>
        </div>
        {live.retrying() ? <StreamRetrying /> : null}
        {live.pending() ? <ListSkeleton rows={2} /> : null}
        {data !== undefined && issues.length === 0 ? (
          <p class="m-0 text-sm opacity-70">No open errors.</p>
        ) : null}
        {issues.length > 0 ? (
          <ul class="list m-0 w-full p-0">
            {issues.map((issue) => (
              <IssueRow
                key={issue.fingerprint}
                issue={issue}
                onPick={() => {
                  navigate(`${tabHref}&e=${issue.fingerprint}`);
                }}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
};

export const ErrorsPanel = ({ appId }: { appId: string }) => {
  // Status and the open issue live in the URL (like ?t=) so a refresh or a
  // shared link lands on the same view.
  const status = searchParam<ErrorStatus>("es", {
    default: "open",
    parse: toStatus,
  });
  const selected = searchParam("e", { default: "" });
  const role = appDetail(appId).data()?.myRole;
  const canTriage = role === "push" || role === "admin";
  if (selected()) {
    return (
      <ErrorDetailView
        key={selected()}
        appId={appId}
        canTriage={canTriage}
        fingerprint={selected()}
        onBack={() => {
          selected.set("");
        }}
      />
    );
  }
  return (
    <ErrorList
      key={status()}
      appId={appId}
      status={status()}
      onStatus={(next) => {
        status.set(next);
      }}
      onPick={(fingerprint) => {
        selected.set(fingerprint);
      }}
    />
  );
};
