//! Settings tab: identity form, domains, rate limits, collaborators, env,
//! danger zone.
import { navigate, useRoute } from "@ilha/router";
import { atom } from "ilha";

import { appHost } from "../apps";
import {
  addDomain,
  deleteEnv,
  envDotVars,
  inviteCollaborator,
  remove,
  removeCollaborator,
  removeDomain,
  renameApp,
  revokeInvitation,
  setEnv,
  setLimits,
  updateCollaboratorRole,
} from "../apps.server";
import type { EnvVarView } from "../apps.server";
import { Dialog } from "../dialog";
import { errorMessage } from "../errors";
import { dropAppFromSnapshot } from "../feeds";
import { LoadError } from "../load-error";
import {
  appDetail,
  collaborators,
  domains,
  envVars,
  invalidate,
  keys,
  limits,
  pendingInvitations,
} from "../resources";
import { parseAppRole } from "../roles";
import type { AppRole } from "../roles";
import { ListSkeleton, SectionSkeleton } from "../skeletons";

const CollaboratorsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const isAdmin = myRole === "admin";
  const res = collaborators(appId);
  const pending = pendingInvitations(appId, isAdmin);
  const rows = res.data() ?? [];
  const pendingRows = pending.data() ?? [];
  const dialogOpen = atom(false);
  const err = atom("");
  const note = atom("");
  const busy = atom(false);
  const inviteEmail = atom("");
  const inviteRole = atom("view");

  const reload = async () => {
    try {
      await Promise.all([res.refetch(), pending.refetch()]);
      err.set("");
    } catch (error) {
      err.set(errorMessage(error));
    }
  };

  const invite = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    const address = inviteEmail().trim();
    if (!address) {
      err.set("Email is required");
      return;
    }
    const next = parseAppRole(inviteRole());
    busy.set(true);
    try {
      const result = await inviteCollaborator({
        appId,
        email: address,
        role: next ?? "view",
      });
      inviteEmail.set("");
      err.set("");
      // The same wording either way: which addresses have accounts is not
      // the inviter's to learn.
      note.set(
        result.status === "updated"
          ? `${address} is already a collaborator — role updated.`
          : `Invitation sent to ${address}. They see it in Noite after signing in with that address.`
      );
      dialogOpen.set(false);
      await reload();
    } catch (error) {
      err.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="m-0 text-lg font-semibold">Collaborators</h3>
          {isAdmin ? (
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              onclick={() => {
                err.set("");
                note.set("");
                dialogOpen.set(true);
              }}
            >
              Invite
            </button>
          ) : null}
        </div>
        <p class="m-0 text-sm opacity-80">
          Roles: <code>view</code> read-only · <code>push</code> deploy, push
          code, write data · <code>admin</code> members, variables, delete.
        </p>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        {err() ? null : <LoadError error={res.error()} />}
        {note() ? <p class="m-0 text-sm opacity-80">{note()}</p> : null}
        {res.loading() && res.data() === undefined ? (
          <ListSkeleton rows={2} />
        ) : null}
        <ul class="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {rows.map((c) => (
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
                    const raw = e.currentTarget.value;
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
                      err.set(errorMessage(error));
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
                      err.set(errorMessage(error));
                    }
                  }}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {pendingRows.length > 0 ? (
          <div class="flex flex-col gap-1">
            <h4 class="m-0 text-sm font-semibold">Pending invitations</h4>
            <ul class="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {pendingRows.map((pendingInvite) => (
                <li
                  key={pendingInvite.id}
                  class="border-base-300 flex flex-wrap items-center gap-2 border-b py-1 last:border-0"
                >
                  <span class="min-w-0 flex-1 truncate">
                    {pendingInvite.email}
                  </span>
                  <span class="badge badge-ghost badge-sm">
                    {pendingInvite.role}
                  </span>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onclick={async () => {
                      try {
                        await revokeInvitation({
                          appId,
                          inviteId: pendingInvite.id,
                        });
                        await reload();
                      } catch (error) {
                        err.set(errorMessage(error));
                      }
                    }}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Dialog open={dialogOpen} class="modal">
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Invite collaborator</h3>
            <p class="m-0 py-2 text-sm opacity-80">
              They see the invitation after signing in with this email address,
              and join once they accept it. Roles: <code>view</code> read-only ·{" "}
              <code>push</code> deploy, push code, write data ·{" "}
              <code>admin</code> members, variables, delete.
            </p>
            <div class="flex flex-wrap items-end gap-2">
              <fieldset class="fieldset min-w-48 flex-1">
                <label class="label" for="invite-email">
                  Email
                </label>
                <input
                  id="invite-email"
                  class="input input-sm validator"
                  type="email"
                  placeholder="user@example.com"
                  value={inviteEmail()}
                  oninput={(e) => {
                    inviteEmail.set(e.currentTarget.value);
                  }}
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
                  value={inviteRole()}
                  onchange={(e) => {
                    inviteRole.set(e.currentTarget.value);
                  }}
                >
                  <option value="view">view</option>
                  <option value="push">push</option>
                  <option value="admin">admin</option>
                </select>
              </fieldset>
            </div>
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
                class="btn btn-sm btn-neutral"
                disabled={busy()}
                onclick={() => {
                  void invite();
                }}
              >
                {busy() ? "Inviting…" : "Invite"}
              </button>
            </div>
          </div>
          <form method="dialog" class="modal-backdrop">
            <button aria-label="Close dialog" disabled={busy()}>
              close
            </button>
          </form>
        </Dialog>
      </div>
    </section>
  );
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
  if (/[^a-z0-9-]/u.test(value)) {
    return "Only lowercase letters, digits, and hyphens";
  }
  if (value.startsWith("-") || value.endsWith("-")) {
    return "Must start and end with a letter or digit";
  }
  if (MODAL_RESERVED_SLUGS.has(value)) {
    return "Slug is reserved";
  }
  return null;
};

/** Custom domains: hostnames this app answers on, plus the one DNS step the
 * operator owns. The runner owns validation, collisions and the Caddyfile
 * route; adding a hostname here reserves it and the edge picks it up on the
 * next reconcile (a few seconds). */
const CustomDomainsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = domains(appId);
  const err = atom("");
  const note = atom("");
  const busy = atom(false);
  const hostname = atom("");
  const isAdmin = myRole === "admin";

  const reload = async () => {
    try {
      await res.refetch();
      err.set("");
    } catch (error) {
      err.set(errorMessage(error));
    }
  };

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = hostname().trim();
    if (!value) {
      note.set("Enter a hostname first.");
      return;
    }
    busy.set(true);
    note.set("");
    try {
      await addDomain({ appId, hostname: value });
      hostname.set("");
      note.set(
        "Saved. Point an A/AAAA record for it at this server; the certificate issues on the first visit."
      );
      await reload();
    } catch (error) {
      note.set(errorMessage(error));
    }
    busy.set(false);
  };

  const removeDomainRow = async (value: string) => {
    busy.set(true);
    note.set("");
    try {
      await removeDomain({ appId, hostname: value });
      await reload();
    } catch (error) {
      note.set(errorMessage(error));
    }
    busy.set(false);
  };

  const rows = res.data() ?? [];
  if (res.loading() && res.data() === undefined) {
    return <SectionSkeleton lines={2} />;
  }
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <h3 class="m-0 text-lg font-semibold">Custom Domain</h3>
        <p class="m-0 text-sm opacity-70">
          Serve this app from your own hostname. Keep DNS pointed at this
          server; the edge routes the hostname and issues its certificate on
          demand.
        </p>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        {err() ? null : <LoadError error={res.error()} />}
        {rows.length === 0 ? (
          <p class="m-0 text-sm opacity-70">No custom hostnames yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((row) => (
              <li
                key={row.hostname}
                class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
              >
                <span class="font-mono text-xs">{row.hostname}</span>
                {isAdmin ? (
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    disabled={busy()}
                    onclick={() => {
                      void removeDomainRow(row.hostname);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <form class="flex flex-wrap items-end gap-2" onsubmit={add}>
            <fieldset class="fieldset grow">
              <label class="label" for="custom-domain-hostname">
                Hostname
              </label>
              <input
                id="custom-domain-hostname"
                class="input input-sm font-mono"
                value={hostname()}
                placeholder="app.example.com"
                oninput={(e) => {
                  hostname.set(e.currentTarget.value);
                }}
              />
            </fieldset>
            <button type="submit" class="btn btn-sm" disabled={busy()}>
              Add domain
            </button>
          </form>
        ) : (
          <p class="m-0 text-sm opacity-70">
            Only an app admin can add or remove hostnames.
          </p>
        )}
        {note() ? <p class="m-0 text-sm opacity-70">{note()}</p> : null}
      </div>
    </section>
  );
};

/** How a limit reads when it is left at the platform default. */
const defaultLabel = (rpm: number) =>
  rpm === 0 ? "Default: no limit" : `Default: ${rpm}/min`;

/** An input's text as a limit: empty = the platform default (null), else a
 * whole number of requests per minute. `undefined` = not a valid number. */
const parseRpm = (raw: string): number | null | undefined => {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  return Number(value);
};

/** An input's text: the unsaved edit, else the saved limit (empty = default). */
const shownRpm = (draft: string | null, saved: number | null) =>
  draft ?? (saved === null ? "" : String(saved));

/** Edge rate limits (SPEC, Edge limits): requests per minute the edge lets
 * through to this app, per visitor and in total, before answering 429. The
 * runner writes them into the Caddyfile on its next reconcile. */
const RateLimitsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = limits(appId);
  const clientDraft = atom<string | null>(null);
  const appDraft = atom<string | null>(null);
  const err = atom("");
  const note = atom("");
  const busy = atom(false);
  const isAdmin = myRole === "admin";

  const current = res.data();
  if (res.loading() && current === undefined) {
    return <SectionSkeleton lines={2} />;
  }
  if (!current) {
    return (
      <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
        <div class="card-body gap-4">
          <h3 class="m-0 text-lg font-semibold">Rate Limits</h3>
          <LoadError error={res.error()} />
        </div>
      </section>
    );
  }
  const clientText = shownRpm(clientDraft(), current.clientRpm);
  const appText = shownRpm(appDraft(), current.appRpm);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const clientRpm = parseRpm(clientText);
    const appRpm = parseRpm(appText);
    if (clientRpm === undefined || appRpm === undefined) {
      err.set("Limits are whole numbers of requests per minute.");
      return;
    }
    busy.set(true);
    err.set("");
    note.set("");
    try {
      await setLimits({ appId, appRpm, clientRpm });
      clientDraft.set(null);
      appDraft.set(null);
      await res.refetch();
      note.set("Saved. The edge applies it within a few seconds.");
    } catch (error) {
      err.set(errorMessage(error));
    }
    busy.set(false);
  };

  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <h3 class="m-0 text-lg font-semibold">Rate Limits</h3>
        <p class="m-0 text-sm opacity-70">
          Requests per minute the edge lets through to this app, across all its
          hostnames. Past a limit, visitors get{" "}
          <code>429 Too Many Requests</code> with a <code>Retry-After</code>{" "}
          header. Leave a field empty for the platform default, or enter{" "}
          <code>0</code> for no limit.
        </p>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        <form class="flex flex-wrap items-end gap-2" onsubmit={save}>
          <fieldset class="fieldset min-w-40 flex-1">
            <label class="label" for="limit-client">
              Per visitor (IP)
            </label>
            <input
              id="limit-client"
              class="input input-sm"
              type="number"
              min="0"
              step="1"
              value={clientText}
              placeholder={
                current.perClient
                  ? defaultLabel(current.defaults.clientRpm)
                  : "Off on this install"
              }
              disabled={!isAdmin || busy() || !current.perClient}
              oninput={(e) => {
                clientDraft.set(e.currentTarget.value);
              }}
            />
          </fieldset>
          <fieldset class="fieldset min-w-40 flex-1">
            <label class="label" for="limit-app">
              Whole app
            </label>
            <input
              id="limit-app"
              class="input input-sm"
              type="number"
              min="0"
              step="1"
              value={appText}
              placeholder={defaultLabel(current.defaults.appRpm)}
              disabled={!isAdmin || busy()}
              oninput={(e) => {
                appDraft.set(e.currentTarget.value);
              }}
            />
          </fieldset>
          {isAdmin ? (
            <button type="submit" class="btn btn-sm" disabled={busy()}>
              {busy() ? "Saving…" : "Save limits"}
            </button>
          ) : null}
        </form>
        {current.perClient ? null : (
          <p class="m-0 text-sm opacity-70">
            Per-visitor limits are off: this install sits behind a proxy the
            edge does not trust, so every request looks like one visitor. An
            operator enables them with <code>NOITE_TRUSTED_PROXIES</code>.
          </p>
        )}
        {isAdmin ? null : (
          <p class="m-0 text-sm opacity-70">
            Only an app admin can change rate limits.
          </p>
        )}
        {note() ? <p class="m-0 text-sm opacity-70">{note()}</p> : null}
      </div>
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
  const dialogOpen = atom(false);
  const err = atom("");
  const busy = atom(false);
  const slugDraft = atom(slug);
  const slugError = (): string | null => slugValidationMessage(slugDraft());
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
      err.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  const saveSlug = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    const raw = slugDraft();
    const message = slugValidationMessage(raw);
    if (message) {
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
      err.set(errorMessage(error));
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
              draftName.set(e.currentTarget.value);
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
                slugDraft.set(slug);
                dialogOpen.set(true);
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
        <Dialog open={dialogOpen} class="modal">
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Change slug?</h3>
            <p class="m-0 py-2 text-sm opacity-80">
              This renames the app everywhere: the app URL becomes{" "}
              <code id="slug-preview">
                {appHost(
                  `${slugDraft().trim().toLowerCase() || "\u2026"}.localhost`
                )}
              </code>{" "}
              and the git origin moves to the new slug — update your local
              remote (`git remote set-url`) and any bookmarks. The fleet keeps
              running; deploys are blocked while the move completes.
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
                pattern="[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?"
                maxlength={48}
                title="Lowercase letters, digits, and hyphens, 1–48 chars, starting and ending with a letter or digit"
                value={slugDraft()}
                oninput={(e) => {
                  slugDraft.set(e.currentTarget.value);
                }}
              />
            </fieldset>
            <p id="slug-error" class="text-error m-0 text-sm">
              {slugError() ?? ""}
            </p>
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
                disabled={busy() || slugError() !== null}
                onclick={() => {
                  void saveSlug();
                }}
              >
                {busy() ? "Moving…" : "Move app"}
              </button>
            </div>
          </div>
          <form method="dialog" class="modal-backdrop">
            <button aria-label="Close dialog" disabled={busy()}>
              close
            </button>
          </form>
        </Dialog>
      </div>
    </section>
  );
};

/** Tenant env vars (`.dev.vars` model): UI-set vars reach build, release
 * command, and fleet env. Reads are view-gated, writes admin-gated
 * server-side; the form locks for non-admins. Download mirrors the file
 * local dev expects (Cloudflare `.dev.vars` convention). Names starting
 * with `FLAG_` render as on/off toggles (`1`/`0`). */

/** A `FLAG_<NAME>` row is a feature flag: the toggle writes `1`/`0`. */
const isFlag = (name: string) => name.startsWith("FLAG_");

const EnvVarsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = envVars(appId);
  const rows = res.data() ?? [];
  const err = atom("");
  const busy = atom(false);
  const dialogOpen = atom(false);
  const newVarName = atom("");
  const newVarValue = atom("");
  const isAdmin = myRole === "admin";
  const reload = async () => {
    try {
      await res.refetch();
      err.set("");
    } catch (error) {
      err.set(errorMessage(error));
    }
  };
  const toggleFlag = (row: EnvVarView) => {
    if (!isAdmin || busy()) {
      return;
    }
    busy.set(true);
    void (async () => {
      try {
        await setEnv({
          appId,
          name: row.name,
          value: row.value === "1" ? "0" : "1",
        });
        await reload();
      } catch (error) {
        err.set(errorMessage(error));
      }
      busy.set(false);
    })();
  };
  const openModal = () => {
    err.set("");
    newVarName.set("");
    newVarValue.set("");
    dialogOpen.set(true);
  };
  const submit = () => {
    if (busy()) {
      return;
    }
    // Names starting with FLAG_ are saved verbatim: the list renders
    // them as boolean toggles (checked when the value is "1").
    const raw = newVarName().trim();
    if (!raw) {
      err.set("Name is required");
      return;
    }
    const finalValue = newVarValue();
    busy.set(true);
    err.set("");
    void (async () => {
      try {
        await setEnv({ appId, name: raw, value: finalValue });
        newVarName.set("");
        newVarValue.set("");
        dialogOpen.set(false);
        await reload();
      } catch (error) {
        err.set(errorMessage(error));
      }
      busy.set(false);
    })();
  };
  return (
    <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="m-0 text-lg font-semibold">Environment</h3>
          {isAdmin ? (
            <span class="flex items-center gap-2">
              <button
                type="button"
                class="btn btn-sm"
                onclick={() => {
                  void (async () => {
                    try {
                      const text = await envDotVars(appId);
                      const url = URL.createObjectURL(
                        new Blob([text], { type: "text/plain" })
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = ".dev.vars";
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (error) {
                      err.set(errorMessage(error));
                    }
                  })();
                }}
              >
                Download .dev.vars
              </button>
              <button
                type="button"
                class="btn btn-sm btn-neutral"
                onclick={() => {
                  openModal();
                }}
              >
                Add Variable
              </button>
            </span>
          ) : null}
        </div>
        <p class="m-0 text-sm opacity-70">
          Variables reach the build, the release command, and the fleet. Values
          are hidden after saving; names starting with <code>FLAG_</code> render
          as on/off toggles (<code>1</code>/<code>0</code>).
        </p>
        {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
        {err() ? null : <LoadError error={res.error()} />}
        {res.loading() && res.data() === undefined ? (
          <ListSkeleton rows={2} />
        ) : null}
        {rows.length === 0 && !(res.loading() && res.data() === undefined) ? (
          <p class="m-0 text-sm opacity-70">
            No variables yet — add one to configure the build, the release
            command, or the fleet.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul class="list bg-base-100 dark:bg-base-200 w-full">
            {rows.map((r) => (
              <li
                key={r.name}
                class="list-row flex items-center justify-between gap-2"
              >
                {isFlag(r.name) ? (
                  <span class="flex min-w-0 items-center gap-3">
                    <input
                      type="checkbox"
                      class="toggle toggle-sm"
                      aria-label={`Toggle ${r.name}`}
                      checked={r.value === "1"}
                      disabled={!isAdmin || busy()}
                      onchange={() => {
                        toggleFlag(r);
                      }}
                    />
                    <span class="font-mono text-sm">{r.name}</span>
                  </span>
                ) : (
                  <span class="font-mono text-sm">{r.name}</span>
                )}
                <span class="flex items-center gap-2">
                  {isFlag(r.name) ? null : (
                    <span class="text-base-content/60 font-mono text-xs">
                      ••••••
                    </span>
                  )}
                  {isAdmin ? (
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost shrink-0"
                      disabled={busy()}
                      onclick={() => {
                        // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
                        if (!confirm(`Delete ${r.name}?`)) {
                          return;
                        }
                        busy.set(true);
                        void (async () => {
                          try {
                            await deleteEnv({ appId, name: r.name });
                            await reload();
                          } catch (error) {
                            err.set(errorMessage(error));
                          }
                          busy.set(false);
                        })();
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {isAdmin ? null : (
          <p class="m-0 text-sm opacity-70">
            Only admins can add or remove variables.
          </p>
        )}
        <Dialog open={dialogOpen} class="modal">
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Add Variable</h3>
            <p class="m-0 py-2 text-sm opacity-80">
              Names starting with <code>FLAG_</code> become on/off toggles in
              the list. Other values are hidden after saving and can't be viewed
              again.
            </p>
            <fieldset class="fieldset w-full">
              <label class="label" for="newvar-name">
                Name
              </label>
              <input
                id="newvar-name"
                class="input input-sm w-full font-mono"
                placeholder="DATABASE_URL or FLAG_DARK_LAUNCH"
                value={newVarName()}
                oninput={(e) => {
                  newVarName.set(e.currentTarget.value);
                }}
              />
            </fieldset>
            <fieldset class="fieldset w-full">
              <label class="label" for="newvar-value">
                Value
              </label>
              <input
                id="newvar-value"
                class="input input-sm w-full font-mono"
                placeholder="postgres://… (flags use 1/0)"
                value={newVarValue()}
                oninput={(e) => {
                  newVarValue.set(e.currentTarget.value);
                }}
              />
            </fieldset>
            {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
            <div class="modal-action">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  dialogOpen.set(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-sm btn-neutral"
                disabled={busy()}
                onclick={() => {
                  submit();
                }}
              >
                {busy() ? "Saving…" : "Add"}
              </button>
            </div>
          </div>
          <form method="dialog" class="modal-backdrop">
            <button aria-label="Close dialog" disabled={busy()}>
              close
            </button>
          </form>
        </Dialog>
      </div>
    </section>
  );
};

/** Settings tab: identity form above collaborator management. Fetches its
 * own role gate so the tab stays independent of the overview fetch. */
export const AppSettingsPanel = () => {
  const { params } = useRoute();
  const { id } = params();
  const res = appDetail(id ?? "");
  const notice = atom<string | null>(null);

  const info = res.data();
  if (!id) {
    return <p class="text-error m-0 text-sm">Missing app id</p>;
  }
  if (res.loading() && info === undefined) {
    return <SectionSkeleton lines={4} />;
  }
  const loadError = res.error();
  if (loadError && !info) {
    return <p class="text-error m-0 text-sm">{errorMessage(loadError)}</p>;
  }
  if (!info) {
    return null;
  }
  const gate = {
    appId: info.app.id,
    myRole: info.myRole,
    name: info.app.name,
    slug: info.app.slug,
  };
  return (
    <div class="flex flex-col gap-4">
      <AppIdentityForm
        appId={gate.appId}
        name={gate.name}
        slug={gate.slug}
        myRole={gate.myRole}
        onSaved={() => {
          // invalidate (not res.refetch): the page title and the header
          // dropdown read this key through their own resource cells.
          invalidate(keys.appDetail(gate.appId));
        }}
      />
      <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />
      <RateLimitsPanel appId={gate.appId} myRole={gate.myRole} />
      <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />
      <EnvVarsPanel appId={gate.appId} myRole={gate.myRole} />
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
                    dropAppFromSnapshot(gate.appId);
                    navigate("/apps");
                  } catch (error) {
                    notice.set(errorMessage(error));
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
