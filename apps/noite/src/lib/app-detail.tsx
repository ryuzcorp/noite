import { useRoute } from "@ilha/router";
import { atom, unsafe, watch } from "ilha";

import { appUrl, initials, presenceTone } from "./apps";
import {
  appMetrics,
  appSpans,
  get,
  inviteCollaborator,
  listCollaborators,
  remove,
  renameApp,
  removeCollaborator,
  setDesired,
  updateCollaboratorRole,
} from "./apps.server";
import { authClient, hardNav } from "./auth-client";
import type { Deploy } from "./db";
import { parseAppRole } from "./roles";
import type { AppRole } from "./roles";
import type { RunnerMetric, RunnerSpan } from "./runner";
import { AppHeaderSkeleton, ListSkeleton, SectionSkeleton } from "./skeletons";
import { readSwrCache, writeSwrCache } from "./swr-cache";

/** Lucide Pause/Play. Static trusted markup (no user input), so the
 * unsafe() path is appropriate — it parses in the SVG namespace, which
 * inline <svg> JSX can't reach under ilha's HTML-namespace mounting. */
const PAUSE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg>';
const PLAY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const CLOUD_UPLOAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/></svg>';
export const CODE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>';
const INFO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const ARROW_UP_RIGHT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';
const ARROW_LEFT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';

const deployBadge = (status: string) => {
  let tone = "badge-ghost";
  if (status === "success") {
    tone = "badge-primary";
  } else if (status === "failed") {
    tone = "badge-error";
  } else if (status === "building" || status === "deploying") {
    tone = "badge-warning";
  }
  return <span class={`badge badge-sm ${tone}`}>{status}</span>;
};

/** Header status line, rendered from the already-fetched detail (no live
 * subscription — every overview visit used to open an infinite `list()`
 * stream, and unmount cleanup across tab switches is not guaranteed). */
const LiveAppStatus = ({
  app,
}: {
  app: { lastDeploySha: string | null; subdomain: string };
}) => {
  const { port } = window.location;
  const url = port
    ? `http://${app.subdomain}:${port}`
    : `https://${app.subdomain}`;
  return (
    <p class="m-0 opacity-70">
      <a class="link" href={url} target="_blank" rel="noreferrer">
        {app.subdomain}
      </a>
      {app.lastDeploySha ? " · " : " · not deployed"}
      {app.lastDeploySha ? (
        <span class="tooltip font-mono" data-tip={app.lastDeploySha}>
          {app.lastDeploySha.slice(0, 12)}
        </span>
      ) : null}
    </p>
  );
};

/** Deploy (git remote) card dropdown. Lives in the page header next to
 * Code so it works on every tab; loads its own detail via the shared SWR
 * key. CSS-only dropdown (focus-based) — no visibility atom needed. */
export const DeployDropdown = ({ appId }: { appId: string }) => {
  const detail = atom<AppDetailInfo | null>(
    readSwrCache<AppDetailInfo>(`app:${appId}:detail`)
  );
  watch.once(() => {
    void (async () => {
      try {
        const info = await get(appId);
        detail.set(info);
        writeSwrCache(`app:${appId}:detail`, info);
      } catch {
        // Header modal stays shut without data.
      }
    })();
  });

  const info = detail();
  if (!info) {
    return null;
  }
  const canPush = info.myRole === "push" || info.myRole === "admin";
  return (
    <div class="dropdown dropdown-end">
      <div tabindex={0} role="button" class="btn btn-sm btn-neutral">
        <span class="inline-flex items-center gap-1">
          {unsafe(CLOUD_UPLOAD_SVG)}
          Deploy
        </span>
      </div>
      <div
        tabindex={0}
        class="dropdown-content card bg-base-100 dark:bg-base-200 border-base-300 z-10 w-80 border shadow-md"
      >
        <div class="card-body gap-4">
          <h3 class="card-title m-0 text-base">Deploy</h3>
          <code class="bg-base-200 block overflow-x-auto rounded p-2 font-mono text-xs">
            {info.gitRemote}
          </code>
          <p class="m-0 text-sm opacity-80">
            Stock Git over HTTP — push <code>main</code> to deploy. Auth:{" "}
            <code>username={info.username}</code>, password = API key from{" "}
            <a href="/profile" class="link">
              Account
            </a>
            .
          </p>
          {canPush ? null : (
            <p class="m-0 text-sm opacity-70">
              Need <code>push</code> or <code>admin</code> to push;{" "}
              <code>view</code> can fetch.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

const DeployRow = ({ d }: { d: Deploy }) => {
  // Atom-driven expansion (no native <details>): ilha binds no `ontoggle`
  // event and stream re-renders would wipe native open state shut.
  // The log is a sibling <li> (block layout, full width by construction)
  // instead of a grid child — immune to list-row span subtleties.
  const open = atom(false);
  return (
    <>
      <li class="list-row">
        <div>{deployBadge(d.status)}</div>
        <div>
          <div class="font-mono text-sm">
            {d.sha ? d.sha.slice(0, 12) : "—"}
          </div>
          <div class="text-base-content/70 text-xs">
            {new Date(d.createdAt).toLocaleString()}
          </div>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-xs shrink-0"
          aria-expanded={open()}
          onclick={() => {
            open.set(!open());
          }}
        >
          {open() ? "Hide log" : "View log"}
        </button>
      </li>
      {open() ? (
        <li class="px-4 pb-4">
          <div class="bg-base-200 rounded-lg p-3">
            <pre class="max-h-64 overflow-auto rounded font-mono text-xs whitespace-pre-wrap">
              {d.log || "(no log)"}
            </pre>
          </div>
        </li>
      ) : null}
    </>
  );
};

/** Deploy history over SSE (like RuntimeLogs): cache-first seed paints
 * instantly on every mount, then the event stream pushes updates and
 * rewrites the cache — no polling, and rows never remount underneath
 * an open log. */
export const DeployList = ({ appId }: { appId: string }) => {
  const seed = readSwrCache<Deploy[]>(`app:${appId}:deploys`);
  const items = atom<Deploy[]>(seed ?? []);
  const loadError = atom("");
  const loaded = atom(seed !== null);
  watch.once(() => {
    let stopped = false;
    const source = new EventSource(
      `/api/apps/${encodeURIComponent(appId)}/deploys/stream`
    );
    source.addEventListener("message", (event) => {
      try {
        const next: unknown = JSON.parse(event.data);
        if (!Array.isArray(next)) {
          return;
        }
        if (JSON.stringify(items()) === JSON.stringify(next)) {
          return;
        }
        // SAFETY: the runner deploys stream emits the same Deploy rows as
        // the list endpoint; entries flow only into list rendering.
        items.set(next as Deploy[]);
        writeSwrCache(`app:${appId}:deploys`, next);
        loadError.set("");
      } catch {
        loadError.set("Deploy stream sent invalid data");
      }
      loaded.set(true);
    });
    source.addEventListener("error", () => {
      if (!stopped) {
        loadError.set("Deploy stream disconnected — retrying…");
      }
      loaded.set(true);
    });
    return () => {
      stopped = true;
      source.close();
    };
  });
  return (
    <div class="flex w-full flex-col gap-4">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Deployments</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
        </li>
        {!loaded() && items().length === 0 && !loadError() ? (
          <li class="px-4 pt-2 pb-4">
            <ListSkeleton rows={2} />
          </li>
        ) : null}
        {loaded() && items().length === 0 && !loadError() ? (
          <li class="text-base-content/70 px-4 pt-2 pb-4 text-sm">
            No deployments yet. Push to main to trigger one.
          </li>
        ) : null}
        {items().map((d) => (
          <DeployRow key={d.id} d={d} />
        ))}
      </ul>
    </div>
  );
};

// Scroll memory per app (module scope — survives re-renders without
// reactive churn). Pinned-to-bottom follows the tail; scrolled-up stays put.
const logScroll = new Map<string, { stick: boolean; top: number }>();

const rememberScroll = (appId: string, el: HTMLPreElement) => {
  logScroll.set(appId, {
    stick: el.scrollHeight - el.scrollTop - el.clientHeight < 24,
    top: el.scrollTop,
  });
};

const restoreScroll = (appId: string) => {
  const el = document.querySelector("#runtime-logs");
  if (!(el instanceof HTMLPreElement)) {
    return;
  }
  const saved = logScroll.get(appId);
  el.scrollTop = saved && !saved.stick ? saved.top : el.scrollHeight;
};

/**
 * Live tail of the running celld fleet's stdout/stderr (bounded buffer on the
 * runner). Streams SSE and only rerenders when the snapshot actually changes —
 * the buffer resets on runner restart, so this is recent activity only.
 */
export const RuntimeLogs = ({ appId }: { appId: string }) => {
  // Cache-first like the rest: last snapshot paints instantly on every
  // mount (including reloads), then the live stream takes over.
  const lines = atom<string[]>(
    readSwrCache<string[]>(`app:${appId}:logs`) ?? []
  );
  const loadError = atom("");

  watch.once(() => {
    if (lines().length > 0) {
      window.requestAnimationFrame(() => {
        restoreScroll(appId);
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
          restoreScroll(appId);
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
      <div class="flex items-center gap-2">
        <h3 class="m-0 text-lg font-semibold">Runtime logs</h3>
        <span class="badge badge-sm">live</span>
      </div>
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      {lines().length === 0 && !loadError() ? (
        <p class="m-0 text-sm opacity-70">
          No output yet from the running fleet.
        </p>
      ) : (
        <pre
          id="runtime-logs"
          class="bg-base-200 max-h-96 overflow-auto rounded p-3 font-mono text-xs whitespace-pre-wrap"
          onscroll={(e) => {
            const target = e.currentTarget;
            if (target instanceof HTMLPreElement) {
              rememberScroll(appId, target);
            }
          }}
        >
          {lines().join("\n")}
        </pre>
      )}
    </div>
  );
};

const hourKeys = () =>
  Array.from({ length: 24 }, (_, i) =>
    new Date(Date.now() - (23 - i) * 3_600_000).toISOString().slice(0, 13)
  );

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const BarRow = ({
  label,
  values,
  max,
}: {
  label: string;
  values: number[];
  max: number;
}) => (
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between text-xs opacity-80">
      <span>{label}</span>
      <span class="font-medium">{sum(values)}</span>
    </div>
    <div class="flex h-16 items-end gap-px">
      {values.map((v, i) => (
        <div
          class="bg-primary/70 min-w-1 flex-1 rounded-t"
          style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }}
          title={`${hourKeys()[i]} · ${v}`}
        />
      ))}
    </div>
  </div>
);

const MetricsCard = ({ appId }: { appId: string }) => {
  // Cache-first atoms: first paint carries last-good data on EVERY mount
  // (remount timing must never gate the paint); watch.once revalidates.
  const seedRows = readSwrCache<RunnerMetric[]>(`app:${appId}:metrics`);
  const seedSpans = readSwrCache<RunnerSpan[]>(`app:${appId}:spans`);
  const rows = atom<RunnerMetric[]>(seedRows ?? []);
  const spans = atom<RunnerSpan[]>(seedSpans ?? []);
  const loadError = atom("");
  const spansError = atom("");
  // Loaded when a previous fetch settled — even an empty one — so
  // empty-but-fetched states skip the skeleton exactly like cached data.
  const loaded = atom(seedRows !== null);
  watch.once(() => {
    void (async () => {
      // Independent sections: a failure in one must not blank the other.
      try {
        const fresh = await appMetrics(appId);
        rows.set(fresh);
        writeSwrCache(`app:${appId}:metrics`, fresh);
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
      try {
        const fresh = await appSpans(appId);
        spans.set(fresh);
        writeSwrCache(`app:${appId}:spans`, fresh);
      } catch (error) {
        spansError.set(error instanceof Error ? error.message : String(error));
      }
      loaded.set(true);
    })();
  });
  const totalByHour = (kind: "requests" | "cpuMs") =>
    hourKeys().map((key) =>
      sum(
        rows()
          .filter((r) => r.bucketTs.slice(0, 13) === key)
          .map((r) => (kind === "requests" ? r.requests : r.cpuMs))
      )
    );
  const reqs = totalByHour("requests");
  const cpus = totalByHour("cpuMs");
  const totalReq = sum(reqs);
  const totalErr = rows().reduce((a, r) => a + r.errors, 0);
  const totalCpu = sum(cpus);
  const totalLat = rows().reduce((a, r) => a + r.latencyMs, 0);
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <h3 class="m-0 flex items-center gap-2 text-lg font-semibold">
          Usage · last 24h
          <span
            class="tooltip tooltip-right inline-flex opacity-60"
            data-tip="What celld OTel recorded · last hour: request/cell-fetch/startup spans, execution ms, failed spans, and queued time. Errors now come from the trace `ok` flag."
          >
            {unsafe(INFO_SVG)}
          </span>
        </h3>
        {loadError() ? (
          <p class="text-error m-0 text-sm">{loadError()}</p>
        ) : null}
        {!loaded() && rows().length === 0 && !loadError() ? (
          <div
            role="status"
            aria-label="Loading usage"
            class="flex flex-col gap-2"
          >
            <div class="skeleton h-4 w-64" />
            <div class="skeleton h-16 w-full" />
            <div class="skeleton h-16 w-full" />
          </div>
        ) : null}
        {loaded() && rows().length === 0 && !loadError() ? (
          <p class="m-0 text-sm opacity-70">
            No traffic recorded yet — hit the app URL to see requests and CPU.
          </p>
        ) : (
          <>
            <BarRow
              label="Requests (fetch spans)"
              values={reqs}
              max={Math.max(1, ...reqs)}
            />
            <BarRow
              label="CPU ms (process)"
              values={cpus}
              max={Math.max(1, ...cpus)}
            />
            {spans().length > 0 || spansError() ? (
              <div class="flex flex-col gap-2">
                {spansError() ? (
                  <p class="text-warning m-0 text-xs">
                    Spans unavailable: {spansError()}
                  </p>
                ) : null}
                {spans().length > 0 ? (
                  <div class="overflow-x-auto">
                    <table class="table-sm table">
                      <thead>
                        <tr>
                          <th>Span</th>
                          <th class="text-right">n</th>
                          <th class="text-right">ms</th>
                          <th class="text-right">err</th>
                          <th class="text-right">queued</th>
                        </tr>
                      </thead>
                      <tbody>
                        {spans().map((s) => (
                          <tr key={s.name}>
                            <td class="font-mono text-xs">{s.name}</td>
                            <td class="text-right">{s.n.toLocaleString()}</td>
                            <td class="text-right">{s.ms.toLocaleString()}</td>
                            <td class="text-right">
                              {s.err > 0 ? (
                                <span class="text-error">{s.err}</span>
                              ) : (
                                "0"
                              )}
                            </td>
                            <td class="text-right">
                              {s.qwaitMs.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}
            <p class="m-0 text-sm opacity-80">
              {totalReq} requests · {totalErr} errors ·{" "}
              {totalCpu.toLocaleString()} ms CPU ·{" "}
              {(totalLat / 1000).toFixed(1)} s latency
            </p>
          </>
        )}
      </div>
    </section>
  );
};

interface CollaboratorRow {
  createdAt: string;
  email: string;
  name: string;
  role: AppRole;
  userId: string;
}

const CollaboratorsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const seedCollabs = readSwrCache<CollaboratorRow[]>(
    `app:${appId}:collaborators`
  );
  const rows = atom<CollaboratorRow[]>(seedCollabs ?? []);
  const role = atom<AppRole>("view");
  const err = atom("");
  const busy = atom(false);
  const loaded = atom(seedCollabs !== null);
  const isAdmin = myRole === "admin";

  const reload = async () => {
    try {
      const fresh = await listCollaborators(appId);
      rows.set(fresh);
      writeSwrCache(`app:${appId}:collaborators`, fresh);
      err.set("");
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    }
    loaded.set(true);
  };

  watch.once(() => {
    void reload();
  });

  const invite = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    // Read the address from the DOM: the input is uncontrolled so typing
    // never re-renders (and blurs) the field.
    const input = document.querySelector("#invite-email");
    const address = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!address) {
      err.set("Email is required");
      return;
    }
    busy.set(true);
    try {
      await inviteCollaborator({
        appId,
        email: address,
        role: role(),
      });
      if (input instanceof HTMLInputElement) {
        input.value = "";
      }
      await reload();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <h3 class="m-0 text-lg font-semibold">Collaborators</h3>
        <p class="m-0 text-sm opacity-80">
          Roles: <code>view</code> read · <code>push</code> deploy/token ·{" "}
          <code>admin</code> invite &amp; delete.
        </p>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        {!loaded() && rows().length === 0 && !err() ? (
          <ListSkeleton rows={2} />
        ) : null}
        <ul class="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {rows().map((c) => (
            <li
              key={c.userId}
              class="border-base-300 flex flex-wrap items-center gap-2 border-b py-1 last:border-0"
            >
              <span class="min-w-0 flex-1 truncate">
                {c.name || c.email || c.userId}
                {c.email ? <span class="opacity-60"> · {c.email}</span> : null}
              </span>
              {isAdmin ? (
                <select
                  class="select select-sm w-24"
                  onchange={async (e) => {
                    // SAFETY: ilha onchange currentTarget is the <select> that fired.
                    const raw = (e.currentTarget as HTMLSelectElement).value;
                    const next = parseAppRole(raw);
                    if (!next) {
                      return;
                    }
                    try {
                      await updateCollaboratorRole({
                        appId,
                        role: next,
                        userId: c.userId,
                      });
                      await reload();
                    } catch (error) {
                      err.set(
                        error instanceof Error ? error.message : String(error)
                      );
                      await reload();
                    }
                  }}
                >
                  <option value="view" selected={c.role === "view"}>
                    view
                  </option>
                  <option value="push" selected={c.role === "push"}>
                    push
                  </option>
                  <option value="admin" selected={c.role === "admin"}>
                    admin
                  </option>
                </select>
              ) : (
                <span class="badge badge-ghost badge-sm">{c.role}</span>
              )}
              {isAdmin ? (
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={async () => {
                    try {
                      await removeCollaborator({ appId, userId: c.userId });
                      await reload();
                    } catch (error) {
                      err.set(
                        error instanceof Error ? error.message : String(error)
                      );
                    }
                  }}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <div class="mt-1 flex flex-wrap items-end gap-2">
            <fieldset class="fieldset min-w-48 flex-1">
              <label class="label" for="invite-email">
                Invite by email
              </label>
              <input
                id="invite-email"
                class="input input-sm validator"
                type="email"
                placeholder="user@example.com"
              />
              <p class="validator-hint hidden">Enter a valid email address</p>
            </fieldset>
            <fieldset class="fieldset w-24">
              <label class="label" for="invite-role">
                Role
              </label>
              <select
                id="invite-role"
                class="select select-sm"
                value={role()}
                onchange={(e) => {
                  // SAFETY: ilha onchange currentTarget is the <select> that fired.
                  const next = parseAppRole(
                    (e.currentTarget as HTMLSelectElement).value
                  );
                  if (next) {
                    role.set(next);
                  }
                }}
              >
                <option value="view">view</option>
                <option value="push">push</option>
                <option value="admin">admin</option>
              </select>
            </fieldset>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={busy()}
              onclick={invite}
            >
              Invite
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
};

/** Sync the slug modal's live URL preview without reactive state, so typing
 * never re-renders (and blurs) the input. */
const setSlugPreview = (value: string) => {
  const preview = document.querySelector("#slug-preview");
  if (preview) {
    preview.textContent = `${value || "…"}.localhost`;
  }
};

const MODAL_RESERVED_SLUGS = new Set(["_control", "app", "api", "git"]);

/** Live slug validation message (null = valid), mirroring the runner gate. */
const slugValidationMessage = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) {
    return "Slug is required";
  }
  if (value.length > 48) {
    return "Max 48 characters";
  }
  if (/[A-Z]/u.test(value)) {
    return "Lowercase letters only";
  }
  if (/[^a-z-]/u.test(value)) {
    return "Only lowercase letters and hyphens";
  }
  if (value.startsWith("-") || value.endsWith("-")) {
    return "Must start and end with a letter";
  }
  if (MODAL_RESERVED_SLUGS.has(value)) {
    return "Slug is reserved";
  }
  return null;
};

/** Validate the slug modal input as typed, showing the message below the
 * input. Direct DOM writes only, so typing never re-renders (and blurs). */
const showSlugValidation = (value: string) => {
  setSlugPreview(value.trim().toLowerCase());
  const error = document.querySelector("#slug-error");
  if (error) {
    error.textContent = slugValidationMessage(value) ?? "";
  }
};

/** Identity form: display name (regular input) + slug change behind an
 * explicit risk dialog. Admin-only; everyone else sees read-only values. */
const AppIdentityForm = ({
  appId,
  name,
  slug,
  myRole,
  onSaved,
}: {
  appId: string;
  name: string;
  slug: string;
  myRole: AppRole;
  onSaved: () => void;
}) => {
  const draftName = atom(name);
  const dialogOpen = atom(false);
  const err = atom("");
  const busy = atom(false);
  const isAdmin = myRole === "admin";

  const saveName = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    const next = draftName().trim();
    if (!next) {
      err.set("Name is required");
      return;
    }
    busy.set(true);
    try {
      await renameApp({ id: appId, name: next });
      err.set("");
      onSaved();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  const saveSlug = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    const input = document.querySelector("#slug-input");
    const raw = input instanceof HTMLInputElement ? input.value : "";
    const message = slugValidationMessage(raw);
    if (message) {
      const error = document.querySelector("#slug-error");
      if (error) {
        error.textContent = message;
      }
      return;
    }
    const next = raw.trim().toLowerCase();
    busy.set(true);
    try {
      await renameApp({ id: appId, slug: next });
      err.set("");
      dialogOpen.set(false);
      onSaved();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <h3 class="m-0 text-lg font-semibold">Identity</h3>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        <fieldset class="fieldset w-full">
          <label class="label" for="identity-name">
            Name
          </label>
          <input
            id="identity-name"
            class="input input-sm"
            value={draftName()}
            disabled={!isAdmin || busy()}
            placeholder="My Service"
            oninput={(e) => {
              // SAFETY: ilha oninput currentTarget is the <input> that fired.
              draftName.set((e.currentTarget as HTMLInputElement).value);
            }}
          />
        </fieldset>
        {isAdmin ? (
          <div>
            <button
              type="button"
              class="btn btn-sm"
              disabled={busy()}
              onclick={() => {
                void saveName();
              }}
            >
              {busy() ? "Saving…" : "Save name"}
            </button>
          </div>
        ) : null}
        <fieldset class="fieldset w-full">
          <label class="label" for="identity-slug">
            Slug
          </label>
          <input
            id="identity-slug"
            class="input input-sm font-mono"
            value={slug}
            disabled
            readonly
          />
        </fieldset>
        {isAdmin ? (
          <div>
            <button
              type="button"
              class="btn btn-sm"
              disabled={busy()}
              onclick={() => {
                err.set("");
                dialogOpen.set(true);
                const input = document.querySelector("#slug-input");
                if (input instanceof HTMLInputElement) {
                  input.value = slug;
                }
                showSlugValidation(slug);
              }}
            >
              Change slug
            </button>
          </div>
        ) : null}
        {isAdmin ? null : (
          <p class="m-0 text-sm opacity-70">
            Only admins can change the name or slug.
          </p>
        )}
        <div class={`modal ${dialogOpen() ? "modal-open" : ""}`}>
          <div class="modal-box">
            <h3 class="m-0 text-lg font-bold">Change slug?</h3>
            <p class="m-0 py-2 text-sm opacity-80">
              This renames the app everywhere: the internal URL becomes{" "}
              <code id="slug-preview">{slug}.localhost</code> and the git origin
              moves with it — update your local remote (`git remote set-url`)
              and any bookmarks. The fleet keeps running; deploys are blocked
              while the move completes.
            </p>
            <fieldset class="fieldset w-full">
              <label class="label" for="slug-input">
                New slug
              </label>
              <input
                id="slug-input"
                class="input input-sm validator font-mono"
                disabled={busy()}
                placeholder="my-app"
                pattern="[a-z]([a-z-]{0,46}[a-z])?"
                maxlength={48}
                title="Lowercase letters and hyphens, 1–48 chars, starting and ending with a letter"
                oninput={(e) => {
                  const target = e.currentTarget;
                  if (target instanceof HTMLInputElement) {
                    showSlugValidation(target.value);
                  }
                }}
              />
            </fieldset>
            <p id="slug-error" class="text-error m-0 text-sm" />
            <div class="modal-action">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => dialogOpen.set(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-sm btn-warning"
                disabled={busy()}
                onclick={() => {
                  void saveSlug();
                }}
              >
                {busy() ? "Moving…" : "Move app"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

/** Settings tab: identity form above collaborator management. Fetches its
 * own role gate so the tab stays independent of the overview fetch. */
export const AppSettingsPanel = () => {
  const { params } = useRoute();
  // Cache-first seed (see AppDetailPanel): first paint carries data.
  const seedAccess = (() => {
    const { id } = params();
    const cached = id ? readSwrCache<AppDetailInfo>(`app:${id}:detail`) : null;
    return cached
      ? {
          appId: cached.app.id,
          myRole: cached.myRole,
          name: cached.app.name,
          slug: cached.app.slug,
        }
      : null;
  })();
  const ready = atom(seedAccess !== null);
  const access = atom<{
    appId: string;
    myRole: AppRole;
    name: string;
    slug: string;
  } | null>(seedAccess);
  const loadError = atom("");
  const notice = atom<string | null>(null);

  const reload = async () => {
    const { id } = params();
    if (!id) {
      loadError.set("Missing app id");
      ready.set(true);
      return;
    }
    const cached = readSwrCache<AppDetailInfo>(`app:${id}:detail`);
    if (cached) {
      access.set({
        appId: cached.app.id,
        myRole: cached.myRole,
        name: cached.app.name,
        slug: cached.app.slug,
      });
    }
    try {
      const info = await get(id);
      access.set({
        appId: info.app.id,
        myRole: info.myRole,
        name: info.app.name,
        slug: info.app.slug,
      });
      writeSwrCache(`app:${id}:detail`, info);
      loadError.set("");
      ready.set(true);
    } catch (error) {
      loadError.set(error instanceof Error ? error.message : String(error));
      ready.set(true);
    }
  };

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        hardNav("/login");
        return;
      }
      await reload();
    })();
  });

  if (!ready()) {
    return <SectionSkeleton lines={4} />;
  }
  if (loadError()) {
    return <p class="text-error m-0 text-sm">{loadError()}</p>;
  }
  const gate = access();
  if (!gate) {
    return null;
  }
  return (
    <div class="flex flex-col gap-4">
      <AppIdentityForm
        appId={gate.appId}
        name={gate.name}
        slug={gate.slug}
        myRole={gate.myRole}
        onSaved={() => {
          void reload();
        }}
      />
      <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />
      {gate.myRole === "admin" ? (
        <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
          <div class="card-body gap-4">
            <h3 class="text-error m-0 text-lg font-semibold">Danger Zone</h3>
            <p class="m-0 text-sm opacity-80">
              Deleting removes the app, its git remote and its fleet. This
              cannot be undone.
            </p>
            {notice() ? (
              <div class="alert alert-error m-0 py-2" role="alert">
                <span>{notice()}</span>
              </div>
            ) : null}
            <div>
              <button
                type="button"
                class="btn btn-sm btn-error"
                onclick={async () => {
                  if (
                    // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
                    !window.confirm(
                      `Delete ${gate.name}? This removes the app, its git remote and its fleet.`
                    )
                  ) {
                    return;
                  }
                  try {
                    await remove(gate.appId);
                    window.location.replace("/apps");
                  } catch (error) {
                    notice.set(
                      error instanceof Error ? error.message : String(error)
                    );
                  }
                }}
              >
                Delete App
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
};

interface AppDetailInfo {
  app: {
    desiredState: string;
    fleetBucket: string;
    id: string;
    lastDeploySha: string | null;
    lastError: string | null;
    name: string;
    slug: string;
    status: string;
    subdomain: string;
  };
  gitHint: string;
  gitRemote: string;
  myRole: AppRole;
  s3Endpoint: string;
  username: string;
}

export const AppDetailPanel = () => {
  const { params } = useRoute();
  // Cache-first: seed from the last good value at creation so first paint
  // carries data on every mount; watch.once revalidates in background.
  const seed = (() => {
    const { id } = params();
    return id ? readSwrCache<AppDetailInfo>(`app:${id}:detail`) : null;
  })();
  const ready = atom(seed !== null);
  const detail = atom<AppDetailInfo | null>(seed);
  const loadError = atom("");
  const notice = atom<string | null>(null);

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        hardNav("/login");
        return;
      }
      const { id } = params();
      if (!id) {
        loadError.set("Missing app id");
        ready.set(true);
        return;
      }
      const cached = readSwrCache<AppDetailInfo>(`app:${id}:detail`);
      if (cached) {
        detail.set(cached);
      }
      try {
        const info = await get(id);
        detail.set(info);
        writeSwrCache(`app:${id}:detail`, info);
        ready.set(true);
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
        ready.set(true);
      }
    })();
  });

  if (!ready()) {
    return (
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <AppHeaderSkeleton />
        </div>
      </div>
    );
  }
  if (loadError() && !detail()) {
    return (
      <div class="flex flex-col gap-2">
        <p class="text-error">{loadError()}</p>
        <a href="/" class="link">
          Back
        </a>
      </div>
    );
  }
  const info = detail();
  if (!info) {
    return null;
  }
  const { app } = info;
  const canPush = info.myRole === "push" || info.myRole === "admin";

  return (
    <div class="flex flex-col gap-4">
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <a
            href="/apps"
            class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
          >
            {unsafe(ARROW_LEFT_SVG)}
            Apps
          </a>
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-3">
              <div class="avatar avatar-placeholder shrink-0">
                <div class="bg-neutral text-neutral-content w-10 rounded-full">
                  <span class="text-sm">{initials(app.name)}</span>
                </div>
                <span
                  class={`status ${presenceTone(app.status)} absolute right-0 bottom-0`}
                  title={app.status}
                />
              </div>
              <div>
                <h1 class="m-0 text-lg font-semibold">{app.name}</h1>
                <LiveAppStatus app={app} />
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <a
                href={appUrl(app.subdomain)}
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-sm"
              >
                <span class="inline-flex items-center gap-1">
                  {unsafe(ARROW_UP_RIGHT_SVG)}
                  Visit
                </span>
              </a>
              {canPush && app.desiredState !== "deleted" ? (
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={async () => {
                    try {
                      await setDesired({
                        desiredState:
                          app.desiredState === "running"
                            ? "stopped"
                            : "running",
                        id: app.id,
                      });
                      detail.set(await get(app.id));
                      writeSwrCache(`app:${app.id}:detail`, detail());
                      notice.set(null);
                    } catch (error) {
                      notice.set(
                        error instanceof Error ? error.message : String(error)
                      );
                    }
                  }}
                >
                  <span class="inline-flex items-center gap-1">
                    {unsafe(
                      app.desiredState === "running" ? PAUSE_SVG : PLAY_SVG
                    )}
                    {app.desiredState === "running" ? "Stop" : "Start"}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      {app.lastError ? (
        <p class="text-error m-0 text-sm">{app.lastError}</p>
      ) : null}

      <MetricsCard appId={app.id} />
    </div>
  );
};
