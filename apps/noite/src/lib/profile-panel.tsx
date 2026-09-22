import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";

import { createApiKey } from "./apps.server";
import { authClient } from "./auth-client";
import { formatDateTime } from "./dates";
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

/** Create / list / revoke Better Auth API keys (Git push password). */
export const ProfilePanel = () => {
  const ready = atom(false);
  const busy = atom(false);
  const keyError = atom("");
  const keys = atom<ApiKeyRow[]>([]);
  const freshKey = atom<string | null>(null);
  const keyModal = atom(false);
  const saveBusy = atom(false);
  const saveError = atom("");
  const saveOk = atom(false);

  const reload = async () => {
    const result = await authClient.apiKey.list({
      query: { limit: 50, sortBy: "createdAt", sortDirection: "desc" },
    });
    if (result.error) {
      keyError.set(result.error.message ?? "Failed to list API keys");
      return;
    }
    keys.set(result.data?.apiKeys ?? []);
  };

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        navigate("/login");
        return;
      }
      await reload();
      ready.set(true);
      // Uncontrolled inputs (see key-name): preset after first paint so
      // typing never re-renders and blurs the fields. The inputs only
      // exist in the DOM once ready flips, hence the frame delay.
      window.requestAnimationFrame(() => {
        const nameInput = document.querySelector("#profile-name");
        if (nameInput instanceof HTMLInputElement) {
          nameInput.value = data.user.name ?? "";
        }
        const emailInput = document.querySelector("#profile-email");
        if (emailInput instanceof HTMLInputElement) {
          emailInput.value = data.user.email ?? "";
        }
      });
    })();
  });

  const createKey = async (event: SubmitEvent) => {
    event.preventDefault();
    // Read the form from the DOM: inputs are uncontrolled so typing
    // never re-renders (and blurs) the fields.
    const input = document.querySelector("#key-name");
    const label = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!label) {
      keyError.set("Name is required");
      return;
    }
    const appsBox = document.querySelector("#scope-apps");
    const eventsBox = document.querySelector("#scope-events");
    const appManagement =
      !(appsBox instanceof HTMLInputElement) || appsBox.checked;
    const events =
      !(eventsBox instanceof HTMLInputElement) || eventsBox.checked;
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
    const input = document.querySelector("#profile-name");
    const next = input instanceof HTMLInputElement ? input.value.trim() : "";
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
    } catch {
      saveError.set("Failed to update profile");
    } finally {
      saveBusy.set(false);
    }
  };

  if (!ready()) {
    return <SectionSkeleton lines={4} />;
  }

  return (
    <div class="flex flex-col gap-6">
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
              const input = document.querySelector("#key-name");
              if (input instanceof HTMLInputElement) {
                input.value = "";
              }
              for (const id of ["#scope-apps", "#scope-events"]) {
                const box = document.querySelector(id);
                if (box instanceof HTMLInputElement) {
                  box.checked = true;
                }
              }
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
        <div class={`modal ${keyModal() ? "modal-open" : ""}`}>
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
                    checked
                  />
                  App Management — git push, deploys, variables
                </label>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    id="scope-events"
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked
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
            <button
              aria-label="Close dialog"
              disabled={busy()}
              onclick={() => {
                keyModal.set(false);
              }}
            >
              close
            </button>
          </form>
        </div>
        {freshKey() ? (
          <div class="bg-base-200 flex flex-col gap-1 rounded p-3 text-xs">
            <p class="m-0 font-medium">Copy now — shown once:</p>
            <code class="break-all">{freshKey()}</code>
          </div>
        ) : null}
        {keyError() ? <p class="text-error m-0 text-sm">{keyError()}</p> : null}
        {keys().length === 0 ? (
          <p class="m-0 text-sm opacity-70">No API keys yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {keys().map((row) => (
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
