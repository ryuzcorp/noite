import { atom } from "ilha";

import { createApiKey } from "./apps.server";
import { authClient } from "./auth-client";
import { formatDateTime } from "./dates";
import { Dialog } from "./dialog";
import { LoadError } from "./load-error";
import {
  apiKeys,
  invalidate,
  inviteCodes,
  keys as resourceKeys,
  session,
} from "./resources";
import { SectionSkeleton } from "./skeletons";

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: Date | string;
  permissions: Record<string, string[]> | null;
}

/** Display label for a machine scope key. Unknown keys pass through raw. */
const scopeLabel = (key: string): string => {
  if (key === "apps") {
    return "App Management";
  }
  if (key === "events") {
    return "Events";
  }
  return key;
};

/** Human scope badges for a key (`Full access` predates scoped keys). */
const scopeBadges = (
  permissions: Record<string, string[]> | null
): string[] => {
  if (!permissions) {
    return ["Full access"];
  }
  const badges = Object.keys(permissions).map(scopeLabel);
  return badges.length > 0 ? badges : ["Full access"];
};

/** The codes this account can still hand out. Every account receives a share
 * on registration (`INVITES_PER_USER`); this is the only place a non-admin can
 * read them, so it is part of the invite flow rather than a nicety. */
const MyInvitesCard = () => {
  const res = inviteCodes();
  const codes = res.data() ?? [];
  const copied = atom("");
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      copied.set(code);
      setTimeout(() => {
        copied.set("");
      }, 1500);
    } catch {
      copied.set("");
    }
  };
  if (res.loading() && res.data() === undefined) {
    return <SectionSkeleton lines={2} />;
  }
  return (
    <div class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
      <div class="card-body gap-3">
        <h2 class="card-title m-0 text-base">Invitations</h2>
        <p class="m-0 text-sm opacity-70">
          This instance is invite-only. Share a code with someone you want to
          let in; each one works once.
        </p>
        {codes.length === 0 ? (
          <p class="m-0 text-sm opacity-70">
            No codes left — ask an admin for one.
          </p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {codes.map((row) => (
              <li
                key={row.id}
                class="border-base-300 flex items-center justify-between gap-2 rounded border p-2"
              >
                <code class="font-mono text-xs">
                  {copied() === row.code ? "copied" : row.code}
                </code>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  onclick={() => {
                    void copy(row.code);
                  }}
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/** Create / list / revoke Better Auth API keys (Git push password). */
export const AccountPanel = () => {
  const keysRes = apiKeys();
  const keys: ApiKeyRow[] = keysRes.data() ?? [];
  const sessionRes = session();
  const busy = atom(false);
  const keyError = atom("");
  const freshKey = atom<string | null>(null);
  const keyModal = atom(false);
  const saveBusy = atom(false);
  const saveError = atom("");
  const saveOk = atom(false);
  // Unsaved edit of the display name; null = untouched, so the field shows
  // the session's name (including after it loads or refreshes). No session
  // data is copied into atoms — render-time seeding raced ilha's patching
  // and intermittently left Name/Email blank.
  const nameDraft = atom<string | null>(null);
  const keyName = atom("");
  const scopeApps = atom(true);
  const scopeEvents = atom(true);
  const reload = async () => {
    try {
      await keysRes.refetch();
      keyError.set("");
    } catch (error) {
      keyError.set(error instanceof Error ? error.message : String(error));
    }
  };

  const user = sessionRes.data()?.user;
  const nameValue = nameDraft() ?? user?.name ?? "";

  const createKey = async (event: SubmitEvent) => {
    event.preventDefault();
    const label = keyName().trim();
    if (!label) {
      keyError.set("Name is required");
      return;
    }
    const appManagement = scopeApps();
    const events = scopeEvents();
    busy.set(true);
    keyError.set("");
    freshKey.set(null);
    try {
      const { key } = await createApiKey({
        appManagement,
        events,
        name: label,
      });
      freshKey.set(key);
      keyModal.set(false);
      await reload();
    } catch (error) {
      keyError.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  const revoke = async (keyId: string) => {
    busy.set(true);
    keyError.set("");
    const result = await authClient.apiKey.delete({ keyId });
    busy.set(false);
    if (result.error) {
      keyError.set(result.error.message ?? "Failed to revoke API key");
      return;
    }
    if (freshKey()) {
      freshKey.set(null);
    }
    await reload();
  };

  const saveProfile = async () => {
    const next = nameValue.trim();
    if (!next) {
      saveError.set("Display name is required");
      return;
    }
    saveBusy.set(true);
    saveError.set("");
    saveOk.set(false);
    try {
      const result = await authClient.updateUser({ name: next });
      if (result.error) {
        saveError.set(result.error.message ?? "Failed to update profile");
        return;
      }
      saveOk.set(true);
      // The sidebar reads the session resource too: refresh it, then let
      // the field follow the saved name again.
      invalidate(resourceKeys.session);
      nameDraft.set(null);
    } catch {
      saveError.set("Failed to update profile");
    } finally {
      saveBusy.set(false);
    }
  };

  if (keysRes.loading() && keysRes.data() === undefined) {
    return <SectionSkeleton lines={4} />;
  }

  return (
    <div class="flex flex-col gap-6">
      <MyInvitesCard />
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        <h2 class="m-0 text-lg font-semibold">Profile</h2>
        <fieldset class="fieldset w-full">
          <label class="label" for="profile-name">
            Display name
          </label>
          <input
            id="profile-name"
            class="input input-sm"
            name="name"
            maxlength={64}
            placeholder="Name"
            autocomplete="name"
            value={nameValue}
            oninput={(e) => {
              nameDraft.set(e.currentTarget.value);
            }}
          />
        </fieldset>
        <fieldset class="fieldset w-full">
          <label class="label" for="profile-email">
            Email
          </label>
          <input
            id="profile-email"
            class="input input-sm"
            type="email"
            disabled
            value={user?.email ?? ""}
          />
        </fieldset>
        {saveError() ? (
          <p class="text-error m-0 text-sm">{saveError()}</p>
        ) : null}
        {saveOk() ? (
          <p class="text-success m-0 text-sm">Display name updated.</p>
        ) : null}
        <div>
          <button
            type="button"
            class="btn btn-sm btn-neutral"
            disabled={saveBusy()}
            onclick={() => {
              void saveProfile();
            }}
          >
            {saveBusy() ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        <div class="flex items-center justify-between gap-2">
          <h2 class="m-0 text-lg font-semibold">API keys</h2>
          <button
            type="button"
            class="btn btn-sm btn-neutral shrink-0"
            onclick={() => {
              keyName.set("");
              scopeApps.set(true);
              scopeEvents.set(true);
              keyError.set("");
              keyModal.set(true);
            }}
          >
            Create key
          </button>
        </div>
        <p class="m-0 text-sm opacity-80">
          Use a key as the Git HTTPS password (<code>username=git</code>). Push
          requires collaborator <code>push</code> or <code>admin</code> on that
          app. Events-only keys can't push code.
        </p>
        <Dialog open={keyModal} class="modal">
          <div class="modal-box bg-base-100 dark:bg-base-200">
            <h3 class="m-0 text-lg font-bold">Create API key</h3>
            <form onsubmit={createKey}>
              <fieldset class="fieldset w-full">
                <span class="label">Scopes</span>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    id="scope-apps"
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={scopeApps()}
                    onchange={(e) => {
                      scopeApps.set(e.currentTarget.checked);
                    }}
                  />
                  App Management — git push, deploys, variables
                </label>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    id="scope-events"
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={scopeEvents()}
                    onchange={(e) => {
                      scopeEvents.set(e.currentTarget.checked);
                    }}
                  />
                  Events — publish to the event API
                </label>
              </fieldset>
              <fieldset class="fieldset w-full">
                <label class="label" for="key-name">
                  Name
                </label>
                <input
                  id="key-name"
                  class="input input-sm"
                  name="name"
                  maxlength={32}
                  minlength={1}
                  placeholder="ci"
                  autofocus
                  required
                  value={keyName()}
                  oninput={(e) => {
                    keyName.set(e.currentTarget.value);
                  }}
                />
              </fieldset>
              {keyError() ? (
                <p class="text-error m-0 py-2 text-sm">{keyError()}</p>
              ) : null}
              <div class="modal-action">
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={busy()}
                  onclick={() => {
                    keyModal.set(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-sm btn-neutral"
                  disabled={busy()}
                >
                  {busy() ? "Creating…" : "Create key"}
                </button>
              </div>
            </form>
          </div>
          <form method="dialog" class="modal-backdrop">
            <button aria-label="Close dialog" disabled={busy()}>
              close
            </button>
          </form>
        </Dialog>
        {freshKey() ? (
          <div class="bg-base-200 flex flex-col gap-1 rounded p-3 text-xs">
            <p class="m-0 font-medium">Copy now — shown once:</p>
            <code class="break-all">{freshKey()}</code>
          </div>
        ) : null}
        {keyError() ? <p class="text-error m-0 text-sm">{keyError()}</p> : null}
        {keyError() ? null : (
          <LoadError error={keysRes.error()} label="Failed to list API keys" />
        )}
        {keys.length === 0 ? (
          <p class="m-0 text-sm opacity-70">No API keys yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {keys.map((row) => (
              <li
                key={row.id}
                class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
              >
                <div class="flex flex-col gap-0.5">
                  <span class="font-medium">{row.name ?? "unnamed"}</span>
                  <span class="text-xs opacity-70">
                    {row.start ?? row.prefix ?? "••••"} ·{" "}
                    {formatDateTime(row.createdAt)}
                    {row.enabled ? "" : " · disabled"}
                  </span>
                  <span class="flex flex-wrap gap-1">
                    {scopeBadges(row.permissions).map((label) => (
                      <span key={label} class="badge badge-ghost badge-sm">
                        {label}
                      </span>
                    ))}
                  </span>
                </div>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={busy()}
                  onclick={() => {
                    void revoke(row.id);
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
