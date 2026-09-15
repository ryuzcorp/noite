import { useRoute } from "@ilha/router";
import * as Stream from "effect/Stream";
import { atom, unsafe, watch } from "ilha";

import { initials, presenceTone } from "./apps";
import {
  appLogs,
  appMetrics,
  appSpans,
  get,
  inviteCollaborator,
  list,
  listCollaborators,
  listDeploys,
  remove,
  renameApp,
  removeCollaborator,
  setDesired,
  updateCollaboratorRole,
} from "./apps.server";
import { authClient, hardNav } from "./auth-client";
import { Breadcrumbs } from "./breadcrumbs";
import type { App, Deploy } from "./db";
import { parseAppRole } from "./roles";
import type { AppRole } from "./roles";
import type { RunnerMetric, RunnerSpan } from "./runner";

const toStreamError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** Lucide Pause/Play. Static trusted markup (no user input), so the
 * unsafe() path is appropriate — it parses in the SVG namespace, which
 * inline <svg> JSX can't reach under ilha's HTML-namespace mounting. */
const PAUSE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg>';
const PLAY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';

const deployBadge = (status: string) => {
  let tone = "badge-ghost";
  if (status === "success") {
    tone = "badge-success";
  } else if (status === "failed") {
    tone = "badge-error";
  } else if (status === "building" || status === "deploying") {
    tone = "badge-warning";
  }
  return <span class={`badge badge-sm ${tone}`}>{status}</span>;
};

const LiveAppStatus = ({
  appId,
  fallback,
}: {
  appId: string;
  fallback: { status: string; lastDeploySha: string | null; subdomain: string };
}) =>
  Stream.map(
    Stream.fromAsyncIterable(list(), toStreamError),
    (items: App[]) => {
      const app = items.find((a) => a.id === appId);
      const sha = app?.lastDeploySha ?? fallback.lastDeploySha;
      const subdomain = app?.subdomain ?? fallback.subdomain;
      const { port } = window.location;
      const url = port ? `http://${subdomain}:${port}` : `https://${subdomain}`;
      return (
        <p class="m-0 opacity-70">
          <a class="link" href={url} target="_blank" rel="noreferrer">
            {subdomain}
          </a>
          {sha ? " · " : " · not deployed"}
          {sha ? (
            <span class="tooltip font-mono" data-tip={sha}>
              {sha.slice(0, 12)}
            </span>
          ) : null}
        </p>
      );
    }
  );

export const DeployList = ({ appId }: { appId: string }) => {
  const listError = atom("");
  return Stream.map(
    // oxide Stream.catch mirrors an Error channel, not a Promise — the promise lint rules are false positives here.
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/valid-params
    Stream.catch(
      Stream.fromAsyncIterable(listDeploys(appId), toStreamError),
      (cause) => {
        listError.set(cause instanceof Error ? cause.message : String(cause));
        // SAFETY: an empty deploy list is the correct fallback shape when loading fails — the empty array is the Deploy[] literal given by the caller's stream type.
        return Stream.succeed([] as Deploy[]);
      }
    ),
    (items: Deploy[]) => (
      <div class="flex flex-col gap-2">
        <h3 class="m-0 text-lg font-medium">Deploys</h3>
        {listError() ? (
          <p class="text-error m-0 text-sm">{listError()}</p>
        ) : null}
        {items.length === 0 && !listError() ? (
          <p class="m-0 opacity-70">
            No deploys yet. Push to main to trigger one.
          </p>
        ) : null}
        {items.map((d) => (
          <details
            key={d.id}
            class="collapse-arrow border-base-300 rounded-lg border"
          >
            <summary class="collapse-title min-h-0 py-2 text-sm">
              {deployBadge(d.status)} {d.sha ? d.sha.slice(0, 12) : "—"} ·{" "}
              {new Date(d.createdAt).toLocaleString()}
            </summary>
            <div class="collapse-content">
              <pre class="bg-base-200 max-h-64 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
                {d.log || "(no log)"}
              </pre>
            </div>
          </details>
        ))}
      </div>
    )
  );
};

/**
 * Live tail of the running celld fleet's stdout/stderr (bounded buffer on the
 * runner). Polls every 2 s — the buffer resets on runner restart, so this is
 * recent activity only.
 */
export const RuntimeLogs = ({ appId }: { appId: string }) => {
  const lines = atom<string[]>([]);
  const loadError = atom("");

  watch.once(() => {
    const poll = async () => {
      try {
        lines.set(await appLogs(appId));
        loadError.set("");
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);
    return () => window.clearInterval(timer);
  });

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <h3 class="m-0 text-lg font-medium">Runtime logs</h3>
        <span class="badge badge-ghost badge-sm">live · 2s</span>
      </div>
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      {lines().length === 0 && !loadError() ? (
        <p class="m-0 text-sm opacity-70">
          No output yet from the running fleet.
        </p>
      ) : (
        <pre class="bg-base-200 max-h-96 overflow-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">
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
  const rows = atom<RunnerMetric[]>([]);
  const spans = atom<RunnerSpan[]>([]);
  const loadError = atom("");
  const spansError = atom("");
  watch.once(() => {
    void (async () => {
      // Independent sections: a failure in one must not blank the other.
      try {
        rows.set(await appMetrics(appId));
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
      try {
        spans.set(await appSpans(appId));
      } catch (error) {
        spansError.set(error instanceof Error ? error.message : String(error));
      }
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
    <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-3">
      <h3 class="m-0 text-lg font-medium">Usage · last 24h</h3>
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      {rows().length === 0 && !loadError() ? (
        <p class="m-0 text-sm opacity-70">
          No traffic recorded yet — hit the app URL to see requests and CPU.
        </p>
      ) : (
        <>
          <p class="m-0 text-sm opacity-80">
            {totalReq} requests · {totalErr} errors ·{" "}
            {totalCpu.toLocaleString()} ms CPU · {(totalLat / 1000).toFixed(1)}{" "}
            s latency
          </p>
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
                  <p class="m-0 text-xs opacity-60">
                    What celld OTel recorded · last hour:
                    request/cell-fetch/startup spans, execution ms, failed
                    spans, and queued time. Errors now come from the trace `ok`
                    flag.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
};

const CollaboratorsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const rows = atom<
    {
      userId: string;
      email: string;
      name: string;
      role: AppRole;
      createdAt: string;
    }[]
  >([]);
  const email = atom("");
  const role = atom<AppRole>("view");
  const err = atom("");
  const busy = atom(false);
  const isAdmin = myRole === "admin";

  const reload = async () => {
    try {
      rows.set(await listCollaborators(appId));
      err.set("");
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    }
  };

  watch.once(() => {
    void reload();
  });

  const invite = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    busy.set(true);
    try {
      await inviteCollaborator({
        appId,
        email: email(),
        role: role(),
      });
      email.set("");
      await reload();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="border-base-300 flex flex-col gap-2 rounded-lg border p-3">
      <h3 class="m-0 text-lg font-medium">Collaborators</h3>
      <p class="m-0 text-sm opacity-80">
        Roles: <code>view</code> read · <code>push</code> deploy/token ·{" "}
        <code>admin</code> invite &amp; delete.
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
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
                class="select select-bordered select-xs w-24"
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
                class="btn btn-ghost btn-xs"
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
          <label class="form-control min-w-48 flex-1">
            <span class="label-text text-xs">Invite by email</span>
            <input
              class="input input-bordered input-sm"
              type="email"
              value={email()}
              placeholder="user@example.com"
              oninput={(e) => {
                // SAFETY: ilha oninput currentTarget is the <input> that fired.
                email.set((e.currentTarget as HTMLInputElement).value);
              }}
            />
          </label>
          <select
            class="select select-bordered select-sm w-24"
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
          <button
            type="button"
            class="btn btn-sm btn-primary"
            disabled={busy()}
            onclick={invite}
          >
            Invite
          </button>
        </div>
      ) : null}
    </section>
  );
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
  const draftSlug = atom(slug);
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
    const next = draftSlug().trim().toLowerCase();
    if (!next) {
      err.set("Slug is required");
      return;
    }
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
    <section class="border-base-300 flex flex-col gap-2 rounded-lg border p-3">
      <h3 class="m-0 text-lg font-medium">Identity</h3>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      <label class="form-control w-full">
        <span class="label-text text-xs">Name</span>
        <input
          class="input input-bordered input-sm"
          value={draftName()}
          disabled={!isAdmin || busy()}
          placeholder="My Service"
          oninput={(e) => {
            // SAFETY: ilha oninput currentTarget is the <input> that fired.
            draftName.set((e.currentTarget as HTMLInputElement).value);
          }}
        />
      </label>
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
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="opacity-70">Slug:</span>
        <code>{slug}</code>
        {isAdmin ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={busy()}
            onclick={() => {
              draftSlug.set(slug);
              err.set("");
              dialogOpen.set(true);
            }}
          >
            Change slug…
          </button>
        ) : null}
      </div>
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
            <code>{draftSlug() || "…"}.localhost</code> and the git origin moves
            with it — update your local remote (`git remote set-url`) and any
            bookmarks. The fleet keeps running; deploys are blocked while the
            move completes.
          </p>
          <label class="form-control w-full">
            <span class="label-text text-xs">New slug</span>
            <input
              class="input input-bordered input-sm font-mono"
              value={draftSlug()}
              disabled={busy()}
              placeholder="my-app"
              oninput={(e) => {
                // SAFETY: ilha oninput currentTarget is the <input> that fired.
                draftSlug.set((e.currentTarget as HTMLInputElement).value);
              }}
            />
          </label>
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
    </section>
  );
};

/** Settings tab: identity form above collaborator management. Fetches its
 * own role gate so the tab stays independent of the overview fetch. */
export const AppSettingsPanel = () => {
  const { params } = useRoute();
  const ready = atom(false);
  const access = atom<{
    appId: string;
    myRole: AppRole;
    name: string;
    slug: string;
  } | null>(null);
  const loadError = atom("");
  const notice = atom<string | null>(null);

  const reload = async () => {
    const { id } = params();
    if (!id) {
      loadError.set("Missing app id");
      ready.set(true);
      return;
    }
    try {
      const info = await get(id);
      access.set({
        appId: info.app.id,
        myRole: info.myRole,
        name: info.app.name,
        slug: info.app.slug,
      });
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
    return <p class="opacity-70">Loading…</p>;
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
        <section class="border-error/40 flex flex-col gap-2 rounded-lg border p-3">
          <h3 class="text-error m-0 text-lg font-medium">Danger Zone</h3>
          <p class="m-0 text-sm opacity-80">
            Deleting removes the app, its git remote and its fleet. This cannot
            be undone.
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
        </section>
      ) : null}
    </div>
  );
};

export const AppBreadcrumbs = ({ appId }: { appId: string }) => {
  const name = atom<string | null>(null);
  watch.once(() => {
    void (async () => {
      try {
        const info = await get(appId);
        name.set(info.app.name);
      } catch {
        name.set(null);
      }
    })();
  });

  return (
    <Breadcrumbs
      trail={[{ href: "/apps", label: "Apps" }, { label: name() ?? "…" }]}
    />
  );
};

export const AppDetailPanel = () => {
  const { params } = useRoute();
  const ready = atom(false);
  const detail = atom<{
    app: {
      id: string;
      name: string;
      slug: string;
      status: string;
      subdomain: string;
      desiredState: string;
      fleetBucket: string;
      lastDeploySha: string | null;
      lastError: string | null;
    };
    gitRemote: string;
    gitHint: string;
    s3Endpoint: string;
    myRole: AppRole;
    username: string;
  } | null>(null);
  const loadError = atom("");
  const notice = atom<string | null>(null);
  const gitModal = atom(false);

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
      try {
        const info = await get(id);
        detail.set(info);
        ready.set(true);
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
        ready.set(true);
      }
    })();
  });

  if (!ready()) {
    return <p class="opacity-70">Loading…</p>;
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
  const deployLabel = app.lastDeploySha ? "Deploy update" : "Deploy";

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-3">
          <div class="avatar avatar-placeholder shrink-0">
            <div class="bg-neutral text-neutral-content w-12 rounded-full">
              <span class="text-sm">{initials(app.name)}</span>
            </div>
            <span
              class={`status ${presenceTone(app.status)} absolute right-0 bottom-0`}
              title={app.status}
            />
          </div>
          <div>
            <h1 class="m-0 text-2xl font-semibold">{app.name}</h1>
            <LiveAppStatus
              appId={app.id}
              fallback={{
                lastDeploySha: app.lastDeploySha,
                status: app.status,
                subdomain: app.subdomain,
              }}
            />
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onclick={() => {
              gitModal.set(true);
            }}
          >
            {deployLabel}
          </button>
          {canPush && app.desiredState !== "deleted" ? (
            <button
              type="button"
              class="btn btn-sm"
              onclick={async () => {
                try {
                  await setDesired({
                    desiredState:
                      app.desiredState === "running" ? "stopped" : "running",
                    id: app.id,
                  });
                  detail.set(await get(app.id));
                  notice.set(null);
                } catch (error) {
                  notice.set(
                    error instanceof Error ? error.message : String(error)
                  );
                }
              }}
            >
              <span class="inline-flex items-center gap-1">
                {unsafe(app.desiredState === "running" ? PAUSE_SVG : PLAY_SVG)}
                {app.desiredState === "running" ? "Stop" : "Start"}
              </span>
            </button>
          ) : null}
        </div>
      </div>
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      <div class={`modal ${gitModal() ? "modal-open" : ""}`}>
        <div class="modal-box">
          <h3 class="m-0 text-lg font-bold">Deploy</h3>
          <code class="bg-base-200 mt-2 block overflow-x-auto rounded p-2 text-xs">
            {info.gitRemote}
          </code>
          <p class="m-0 py-2 text-sm opacity-80">
            Stock Git over HTTP — push <code>main</code> to deploy. Auth:{" "}
            <code>username={info.username}</code>, password = API key from{" "}
            <a href="/profile" class="link">
              Profile
            </a>
            .
          </p>
          {canPush ? null : (
            <p class="m-0 text-sm opacity-70">
              Need <code>push</code> or <code>admin</code> to push;{" "}
              <code>view</code> can fetch.
            </p>
          )}
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                gitModal.set(false);
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {app.lastError ? (
        <p class="text-error m-0 text-sm">{app.lastError}</p>
      ) : null}

      <MetricsCard appId={app.id} />
    </div>
  );
};
