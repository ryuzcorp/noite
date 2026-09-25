//! Settings tab: identity form, collaborators, danger zone.
import { navigate, useRoute } from "@ilha/router";
import { atom, watch } from "ilha";

import { appHost } from "../apps";
import {
  addDomain,
  deleteEnv,
  envDotVars,
  get,
  inviteCollaborator,
  listCollaborators,
  listDomains,
  listEnv,
  remove,
  removeCollaborator,
  removeDomain,
  renameApp,
  setEnv,
  updateCollaboratorRole,
} from "../apps.server";
import { parseAppRole } from "../roles";
import type { AppRole } from "../roles";
import type { RunnerDomain, RunnerEnv } from "../runner";
import { fetchSession } from "../session";
import { ListSkeleton, SectionSkeleton } from "../skeletons";
import { readSwrCache, writeSwrCache } from "../swr-cache";
import type { AppDetailInfo } from "./panel";

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
  const dialogOpen = atom(false);
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
    // Read the form from the DOM: inputs are uncontrolled so typing
    // never re-renders (and blurs) the fields.
    const input = document.querySelector("#invite-email");
    const address = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!address) {
      err.set("Email is required");
      return;
    }
    const roleInput = document.querySelector("#invite-role");
    const next =
      roleInput instanceof HTMLSelectElement
        ? parseAppRole(roleInput.value)
        : null;
    busy.set(true);
    try {
      await inviteCollaborator({
        appId,
        email: address,
        role: next ?? "view",
      });
      if (input instanceof HTMLInputElement) {
        input.value = "";
      }
      err.set("");
      dialogOpen.set(false);
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
        <div class="flex items-center justify-between gap-2">
          <h3 class="m-0 text-lg font-semibold">Collaborators</h3>
          {isAdmin ? (
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              onclick={() => {
                err.set("");
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
        <div class={`modal ${dialogOpen() ? "modal-open" : ""}`}>
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Invite collaborator</h3>
            <p class="m-0 py-2 text-sm opacity-80">
              They join by signing in with this email address. Roles:{" "}
              <code>view</code> read-only · <code>push</code> deploy, push code,
              write data · <code>admin</code> members, variables, delete.
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
                />
                <p class="validator-hint hidden">Enter a valid email address</p>
              </fieldset>
              <fieldset class="fieldset w-24">
                <label class="label" for="invite-role">
                  Role
                </label>
                <select id="invite-role" class="select select-sm">
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
            <button
              aria-label="Close dialog"
              disabled={busy()}
              onclick={() => dialogOpen.set(false)}
            >
              close
            </button>
          </form>
        </div>
      </div>
    </section>
  );
};

/** Sync the slug modal's live URL preview without reactive state, so typing
 * never re-renders (and blurs) the input. */
const setSlugPreview = (value: string) => {
  const preview = document.querySelector("#slug-preview");
  if (preview) {
    preview.textContent = appHost(`${value || "…"}.localhost`);
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

/** Validate the slug modal input as typed, showing the message below the
 * input. Direct DOM writes only, so typing never re-renders (and blurs). */
const showSlugValidation = (value: string) => {
  setSlugPreview(value.trim().toLowerCase());
  const error = document.querySelector("#slug-error");
  if (error) {
    error.textContent = slugValidationMessage(value) ?? "";
  }
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
  const rows = atom<RunnerDomain[]>([]);
  const err = atom("");
  const note = atom("");
  const busy = atom(false);
  const loaded = atom(false);
  const hostname = atom("");
  const isAdmin = myRole === "admin";

  const reload = async () => {
    try {
      const listed = await listDomains(appId);
      rows.set(listed ?? []);
      err.set("");
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    }
    loaded.set(true);
  };

  watch.once(() => {
    void reload();
  });

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
      note.set(error instanceof Error ? error.message : String(error));
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
      note.set(error instanceof Error ? error.message : String(error));
    }
    busy.set(false);
  };

  if (!loaded()) {
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
        {rows().length === 0 ? (
          <p class="m-0 text-sm opacity-70">No custom hostnames yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {rows().map((row) => (
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
                  // SAFETY: ilha oninput currentTarget is the <input> that fired.
                  hostname.set((e.currentTarget as HTMLInputElement).value);
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
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Change slug?</h3>
            <p class="m-0 py-2 text-sm opacity-80">
              This renames the app everywhere: the app URL becomes{" "}
              <code id="slug-preview">{slug}.localhost</code> and the git origin
              moves to the new slug — update your local remote (`git remote
              set-url`) and any bookmarks. The fleet keeps running; deploys are
              blocked while the move completes.
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
          <form method="dialog" class="modal-backdrop">
            <button
              aria-label="Close dialog"
              disabled={busy()}
              onclick={() => dialogOpen.set(false)}
            >
              close
            </button>
          </form>
        </div>
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

/** Read an uncontrolled modal input from the DOM (see EnvVarsPanel). */
const readModalInput = (id: string): string => {
  const el = document.querySelector(`#${id}`);
  return el instanceof HTMLInputElement ? el.value : "";
};

/** Clear the Add Variable modal inputs imperatively. */
const clearModalInputs = () => {
  for (const id of ["newvar-name", "newvar-value"]) {
    const el = document.querySelector(`#${id}`);
    if (el instanceof HTMLInputElement) {
      el.value = "";
    }
  }
};

const EnvVarsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const rows = atom<RunnerEnv[]>([]);
  const err = atom("");
  const busy = atom(false);
  const loaded = atom(false);
  const dialogOpen = atom(false);
  const isAdmin = myRole === "admin";
  const reload = async () => {
    try {
      rows.set(await listEnv(appId));
      err.set("");
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    }
    loaded.set(true);
  };
  watch.once(() => {
    void reload();
  });
  const toggleFlag = (row: RunnerEnv) => {
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
        err.set(error instanceof Error ? error.message : String(error));
      }
      busy.set(false);
    })();
  };
  // Modal inputs are uncontrolled (read from the DOM on submit): binding
  // value={atom()} re-renders on every keystroke and steals input focus.
  const openModal = () => {
    err.set("");
    dialogOpen.set(true);
    clearModalInputs();
  };
  const submit = () => {
    if (busy()) {
      return;
    }
    // Names starting with FLAG_ are saved verbatim: the list renders
    // them as boolean toggles (checked when the value is "1").
    const raw = readModalInput("newvar-name").trim();
    if (!raw) {
      err.set("Name is required");
      return;
    }
    const finalValue = readModalInput("newvar-value");
    busy.set(true);
    err.set("");
    void (async () => {
      try {
        await setEnv({ appId, name: raw, value: finalValue });
        clearModalInputs();
        dialogOpen.set(false);
        await reload();
      } catch (error) {
        err.set(error instanceof Error ? error.message : String(error));
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
                      err.set(
                        error instanceof Error ? error.message : String(error)
                      );
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
        {loaded() ? null : <ListSkeleton rows={2} />}
        {loaded() && rows().length === 0 ? (
          <p class="m-0 text-sm opacity-70">
            No variables yet — add one to configure the build, the release
            command, or the fleet.
          </p>
        ) : null}
        {loaded() && rows().length > 0 ? (
          <ul class="list bg-base-100 dark:bg-base-200 w-full">
            {rows().map((r) => (
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
                            err.set(
                              error instanceof Error
                                ? error.message
                                : String(error)
                            );
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
        <div class={`modal ${dialogOpen() ? "modal-open" : ""}`}>
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
            <button
              aria-label="Close dialog"
              disabled={busy()}
              onclick={() => {
                dialogOpen.set(false);
              }}
            >
              close
            </button>
          </form>
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
      const { data } = await fetchSession();
      if (!data?.user) {
        navigate("/login");
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
      <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />
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
                    navigate("/apps");
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
