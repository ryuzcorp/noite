import { atom } from "ilha";
import type { AtomHandle } from "ilha";

import { api } from "../api";
import { authClient } from "../auth-client";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import {
  applistUrl,
  decodeApps,
  feedKeys,
  feedValue,
  liveFeed,
} from "../feeds";
import {
  isExpiryPreset,
  keyScopeOf,
  parseKeyScope,
  ROLE_CEILINGS,
} from "../key-principal";
import type {
  ExpiryPreset,
  KeyScope as KeyScopeSetting,
} from "../key-principal";
import { resourceValue, resourceError } from "../resource";
import {
  apiKeys,
  invalidate,
  inviteCodes,
  keys as resourceKeys,
  passkeys,
  session,
} from "../resources";
import { parseAppRole } from "../roles";
import type { AppRole } from "../roles";
import { confirmDialog } from "../ui/confirm";
import { CopyButton } from "../ui/copy-button";
import { Dialog } from "../ui/dialog";
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";
import { ConnectAgentCard } from "./agent-connect";
import {
  createKeyBody,
  draftProblem,
  newKeyDraft,
  scopeSelection,
  toggleApp,
  toggleScope,
  withCeiling,
  withExpiry,
  withScope,
} from "./api-key.machine";
import type { KeyDraft } from "./api-key.machine";

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
  lastRequest?: Date | string | null;
  metadata?: unknown;
  permissions: Record<string, string[]> | null;
}

/** The role words the ceiling select and badge read. */
const CEILING_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  push: "Push",
  view: "View",
};

/** The expiry presets in offer order, with the words the select shows. */
const EXPIRY_OPTIONS = [
  { label: "Never", value: "never" },
  { label: "1 hour", value: "1h" },
  { label: "1 day", value: "1d" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
] as const satisfies readonly { label: string; value: ExpiryPreset }[];

/** The apps a key is limited to, as one compact badge ("All apps" or the
 * slugs, collapsed past two). An id no longer among the account's apps is
 * named as gone instead of silently vanishing: the key still holds it. */
const appsBadge = (
  appIds: readonly string[] | null,
  names: Map<string, string>
): string => {
  if (appIds === null) {
    return "All apps";
  }

  const labels = appIds.map((id) => names.get(id) ?? "(deleted app)");

  return labels.length <= 2
    ? labels.join(", ")
    : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
};

/** A key's expiry as the row reads it. */
const expiryText = (expiresAt: Date | string | null | undefined): string => {
  if (expiresAt === null || expiresAt === undefined) {
    return "no expiry";
  }

  const at = new Date(expiresAt);

  if (Number.isNaN(at.getTime())) {
    return "expiry unavailable";
  }

  return at.getTime() <= Date.now()
    ? `expired ${formatDateTime(at)}`
    : `expires ${formatDateTime(at)}`;
};

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
  const codes = resourceValue(res.state()) ?? [];

  if (res.state()._tag === "Loading") {
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
                <code class="font-mono text-xs">{row.code}</code>
                <CopyButton
                  class="btn btn-sm btn-ghost gap-1"
                  label="Copy invite code"
                  value={row.code}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/** Registered passkeys: list, add another device, rename, remove. This is
 * also where an account that signed in with an emailed code (its passkey was
 * lost) registers a replacement. */
const PasskeysCard = () => {
  const res = passkeys();
  const rows = resourceValue(res.state()) ?? [];
  const busy = atom(false);
  const error = atom("");
  const nameDraft = atom("");

  const reload = async () => {
    try {
      await res.refetch();
    } catch (loadError) {
      error.set(errorMessage(loadError));
    }
  };

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    busy.set(true);
    error.set("");
    const label = nameDraft().trim();

    try {
      // Signed in, so the server adds it to this account (no registration
      // context, no invite): see `afterVerification` in auth.ts.
      const result = await authClient.passkey.addPasskey({
        name: label || `Passkey ${rows.length + 1}`,
      });

      if (result.error) {
        error.set(result.error.message ?? "Could not add the passkey");
      } else {
        nameDraft.set("");
        await reload();
      }
    } catch (addError) {
      error.set(errorMessage(addError));
    }

    busy.set(false);
  };

  const rename = async (id: string, current: string) => {
    // oxlint-disable-next-line no-alert -- native prompt is enough for a one-field rename.
    const next = window.prompt("Passkey name", current)?.trim();

    if (!next || next === current) {
      return;
    }

    busy.set(true);
    error.set("");
    const result = await authClient.passkey.updatePasskey({ id, name: next });
    busy.set(false);

    if (result.error) {
      error.set(result.error.message ?? "Could not rename the passkey");

      return;
    }

    await reload();
  };

  const remove = async (id: string, name: string) => {
    if (rows.length <= 1) {
      // The last passkey is not deletable: with email delivery unconfigured
      // (NOITE_EMAIL_WEBHOOK_URL unset) that would lock the account out for
      // good. Add another device first, then remove this one.
      error.set(
        "This is your only passkey — add another one first, then delete this."
      );

      return;
    }

    const ok = await confirmDialog({
      confirmLabel: "Delete",
      message: "You can no longer sign in with it.",
      title: `Delete ${name || "this passkey"}?`,
    });

    if (ok !== "confirm") {
      return;
    }

    busy.set(true);
    error.set("");
    const result = await authClient.passkey.deletePasskey({ id });
    busy.set(false);

    if (result.error) {
      error.set(result.error.message ?? "Could not delete the passkey");

      return;
    }

    await reload();
  };

  if (res.state()._tag === "Loading") {
    return <SectionSkeleton lines={2} />;
  }

  return (
    <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
      <h2 class="m-0 text-lg font-semibold">Passkeys</h2>
      {rows.length === 0 && !resourceError(res.state()) ? (
        <p class="text-warning m-0 text-sm">
          This account has no passkey — you are signing in with emailed codes.
          Add one below so you don't need them.
        </p>
      ) : (
        <p class="m-0 text-sm opacity-80">
          Passkeys are how you sign in. Add one per device you use; if you lose
          them all, an emailed code still gets you in.
        </p>
      )}
      {error() ? <p class="text-error m-0 text-sm">{error()}</p> : null}
      {error() ? null : (
        <LoadError
          error={resourceError(res.state())}
          label="Failed to list passkeys"
        />
      )}
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row) => (
          <li
            key={row.id}
            class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
          >
            <div class="flex flex-col gap-0.5">
              <span class="font-medium">{row.name || "Unnamed passkey"}</span>
              <span class="text-xs opacity-70">
                {row.deviceType === "multiDevice" ? "Synced" : "This device"}
                {row.backedUp ? " · backed up" : ""}
                {row.createdAt
                  ? ` · added ${formatDateTime(row.createdAt)}`
                  : ""}
              </span>
            </div>
            <span class="flex gap-2">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  void rename(row.id, row.name);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  void remove(row.id, row.name);
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form class="flex flex-wrap items-end gap-2" onsubmit={add}>
        <fieldset class="fieldset grow">
          <label class="label" for="passkey-name">
            Name
          </label>
          <input
            id="passkey-name"
            class="input input-sm"
            maxlength={64}
            placeholder="Laptop, phone, security key…"
            value={nameDraft()}
            oninput={(e) => {
              nameDraft.set(e.currentTarget.value);
            }}
          />
        </fieldset>
        <button type="submit" class="btn btn-sm btn-neutral" disabled={busy()}>
          {busy() ? "Waiting…" : "Add passkey"}
        </button>
      </form>
    </section>
  );
};

/** The app picker: every app the account can see, all checked meaning
 * account-wide. Unchecking one narrows the key to the rest. */
const KeyAppsField = ({
  apps,
  onToggle,
  selected,
}: {
  apps: { id: string; slug: string }[];
  onToggle: (appId: string, on: boolean) => void;
  selected: readonly string[] | null;
}) => {
  if (apps.length === 0) {
    return (
      <fieldset class="fieldset w-full">
        <span class="label">Apps</span>
        <p class="m-0 text-sm opacity-70">
          No apps yet — this key is account-wide.
        </p>
      </fieldset>
    );
  }

  return (
    <fieldset class="fieldset w-full">
      <span class="label">Apps</span>
      <div class="flex max-h-40 flex-col overflow-y-auto">
        {apps.map((app) => (
          <label
            key={app.id}
            class="flex cursor-pointer items-center gap-2 text-sm"
          >
            <input
              id={`key-app-${app.id}`}
              type="checkbox"
              class="checkbox checkbox-sm"
              checked={selected === null || selected.includes(app.id)}
              onchange={(e) => {
                onToggle(app.id, e.currentTarget.checked);
              }}
            />
            <span class="font-mono text-xs">{app.slug}</span>
          </label>
        ))}
      </div>
      <p class="m-0 text-xs opacity-70">
        Uncheck an app to limit the key to the rest. All checked means
        account-wide, including apps you create later.
      </p>
    </fieldset>
  );
};

/** The role ceiling and expiry selects, with the only values this build
 * mints. */
const KeyLimitFields = ({
  ceiling,
  expiry,
  onCeiling,
  onExpiry,
}: {
  ceiling: AppRole;
  expiry: ExpiryPreset;
  onCeiling: (ceiling: AppRole) => void;
  onExpiry: (expiry: ExpiryPreset) => void;
}) => (
  <div class="flex gap-3">
    <fieldset class="fieldset w-full">
      <label class="label" for="key-ceiling">
        Role ceiling
      </label>
      <select
        id="key-ceiling"
        class="select select-sm"
        value={ceiling}
        onchange={(e) => {
          const role = parseAppRole(e.currentTarget.value);

          if (role) {
            onCeiling(role);
          }
        }}
      >
        {ROLE_CEILINGS.map((role) => (
          <option key={role} value={role}>
            {CEILING_LABEL[role]}
          </option>
        ))}
      </select>
    </fieldset>
    <fieldset class="fieldset w-full">
      <label class="label" for="key-expiry">
        Expires
      </label>
      <select
        id="key-expiry"
        class="select select-sm"
        value={expiry}
        onchange={(e) => {
          if (isExpiryPreset(e.currentTarget.value)) {
            onExpiry(e.currentTarget.value);
          }
        }}
      >
        {EXPIRY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </fieldset>
  </div>
);

/** One key's row: label, provenance, scope badges and the revoke action. */
const KeyRow = ({
  appNames,
  busy,
  onRevoke,
  revoking,
  row,
}: {
  appNames: Map<string, string>;
  busy: boolean;
  onRevoke: (keyId: string) => Promise<void>;
  revoking: boolean;
  row: ApiKeyRow;
}) => {
  const read = parseKeyScope(row.metadata);

  const setting: KeyScopeSetting | null =
    read._tag === "Malformed" ? null : keyScopeOf(read);

  return (
    <li class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
      <div class="flex flex-col gap-0.5">
        <span class="font-medium">{row.name ?? "unnamed"}</span>
        <span class="text-xs opacity-70">
          {row.start ?? row.prefix ?? "••••"} · created{" "}
          {formatDateTime(row.createdAt)} · {expiryText(row.expiresAt)} ·{" "}
          {row.lastRequest
            ? `last used ${formatDateTime(row.lastRequest)}`
            : "never used"}
          {row.enabled ? "" : " · disabled"}
        </span>
        <span class="flex flex-wrap gap-1">
          {scopeBadges(row.permissions).map((label) => (
            <span key={label} class="badge badge-ghost badge-sm">
              {label}
            </span>
          ))}
          {setting === null ? (
            <span class="badge badge-error badge-sm">
              unreadable scope — refused
            </span>
          ) : (
            <>
              <span class="badge badge-outline badge-sm">
                {appsBadge(setting.appIds, appNames)}
              </span>
              <span class="badge badge-outline badge-sm">
                ≤ {CEILING_LABEL[setting.roleCeiling]}
              </span>
            </>
          )}
        </span>
      </div>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        disabled={busy}
        onclick={() => {
          void onRevoke(row.id);
        }}
      >
        {revoking ? "Revoking…" : "Revoke"}
      </button>
    </li>
  );
};

/** The create-key dialog: name, scopes, apps, ceiling and expiry, all from
 * the draft the panel holds. */
const CreateKeyDialog = ({
  apps,
  busy,
  draft,
  error,
  name,
  onDraft,
  onName,
  everyAppId,
  onSubmit,
  open,
}: {
  apps: { id: string; slug: string }[];
  busy: boolean;
  draft: KeyDraft;
  error: string;
  everyAppId: readonly string[];
  name: string;
  onDraft: (next: KeyDraft) => void;
  onName: (next: string) => void;
  onSubmit: (event: SubmitEvent) => void;
  open: AtomHandle<boolean>;
}) => {
  const problem = draftProblem(draft);

  return (
    <Dialog open={open} class="modal">
      <div class="modal-box bg-base-100 dark:bg-base-200">
        <h3 class="m-0 text-lg font-bold">Create API key</h3>
        <form onsubmit={onSubmit}>
          <fieldset class="fieldset w-full">
            <span class="label">Scopes</span>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                id="scope-apps"
                type="checkbox"
                class="checkbox checkbox-sm"
                checked={scopeSelection(draft.scope).apps}
                onchange={(e) => {
                  onDraft(
                    withScope(
                      draft,
                      toggleScope(draft.scope, "apps", e.currentTarget.checked)
                    )
                  );
                }}
              />
              App Management — git push, deploys, variables
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                id="scope-events"
                type="checkbox"
                class="checkbox checkbox-sm"
                checked={scopeSelection(draft.scope).events}
                onchange={(e) => {
                  onDraft(
                    withScope(
                      draft,
                      toggleScope(
                        draft.scope,
                        "events",
                        e.currentTarget.checked
                      )
                    )
                  );
                }}
              />
              Events — publish to the event API
            </label>
          </fieldset>
          <KeyAppsField
            apps={apps}
            selected={draft.appIds}
            onToggle={(appId, on) => {
              onDraft(toggleApp(draft, appId, on, everyAppId));
            }}
          />
          <KeyLimitFields
            ceiling={draft.ceiling}
            expiry={draft.expiry}
            onCeiling={(role) => {
              onDraft(withCeiling(draft, role));
            }}
            onExpiry={(preset) => {
              onDraft(withExpiry(draft, preset));
            }}
          />
          <p class="m-0 text-xs opacity-70">
            The effective role is the lower of yours on the app and this
            ceiling.
          </p>
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
              value={name}
              oninput={(e) => {
                onName(e.currentTarget.value);
              }}
            />
          </fieldset>
          {error ? <p class="text-error m-0 py-2 text-sm">{error}</p> : null}
          {problem === null ? null : (
            <p class="text-warning m-0 py-2 text-sm">{problem}</p>
          )}
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={busy}
              onclick={() => {
                open.set(false);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-sm btn-neutral"
              disabled={busy || problem !== null}
            >
              {busy ? "Creating…" : "Create key"}
            </button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button aria-label="Close dialog" disabled={busy}>
          close
        </button>
      </form>
    </Dialog>
  );
};

/** What the API-key card is doing, per action and (for a revoke) per row. */
type KeyPending =
  | { readonly action: "create" }
  | { readonly action: "revoke"; readonly id: string }
  | null;

/** How long a freshly created secret stays on the page. */
const KEY_REVEAL_MS = 10 * 60 * 1000;

/** Create / list / revoke Better Auth API keys (Git push password). */
export const AccountPanel = () => {
  const keysRes = apiKeys();
  const keys: ApiKeyRow[] = resourceValue(keysRes.state()) ?? [];
  const sessionRes = session();
  // One pending action for this card, keyed by what it is doing: the old
  // shared `busy` disabled every row and the Create button alike, with no way
  // to say which one was in flight.
  const pending = atom<KeyPending>(null);
  const busy = (): boolean => pending() !== null;
  const keyError = atom("");
  // The freshly created secret. Shown once and only for a bounded time: it
  // used to live in the page (and in the agent snippets) until revoke or
  // navigation.
  const freshKey = atom<string | null>(null);
  const keyModal = atom(false);
  // Holds the reveal timer across re-renders (a body `let` would be reset).
  const keyTimer = atom.lazy<{ id: number | null }>(() => ({ id: null }))();
  const saveBusy = atom(false);
  const saveError = atom("");
  const saveOk = atom(false);
  // Unsaved edit of the display name; null = untouched, so the field shows
  // the session's name (including after it loads or refreshes). No session
  // data is copied into atoms — render-time seeding raced ilha's patching
  // and intermittently left Name/Email blank.
  const nameDraft = atom<string | null>(null);
  const keyName = atom("");
  // The whole create form as one value, never "neither scope" and never an
  // empty app set (./api-key.machine).
  const draft = atom<KeyDraft>(newKeyDraft());
  // The account's apps for the picker: the same live feed the sidebar reads,
  // so an app created while the dialog is open appears without a reload.
  const appsFeed = liveFeed(feedKeys.apps, applistUrl(), decodeApps);
  const apps = feedValue(appsFeed.state()) ?? [];
  const appNames = new Map(apps.map((app) => [app.id, app.slug]));
  const everyAppId = apps.map((app) => app.id);

  const reload = async () => {
    try {
      await keysRes.refetch();
      keyError.set("");
    } catch (error) {
      keyError.set(errorMessage(error));
    }
  };

  const user = resourceValue(sessionRes.state())?.user;
  const nameValue = nameDraft() ?? user?.name ?? "";

  const revealKey = (key: string): void => {
    freshKey.set(key);

    if (keyTimer.id !== null) {
      window.clearTimeout(keyTimer.id);
    }

    keyTimer.id = window.setTimeout(() => {
      freshKey.set(null);
      keyTimer.id = null;
    }, KEY_REVEAL_MS);
  };

  const hideKey = (): void => {
    if (keyTimer.id !== null) {
      window.clearTimeout(keyTimer.id);
      keyTimer.id = null;
    }

    freshKey.set(null);
  };

  const createKey = async (event: SubmitEvent) => {
    event.preventDefault();
    const label = keyName().trim();

    if (!label) {
      keyError.set("Name is required");

      return;
    }

    const problem = draftProblem(draft());

    if (problem !== null) {
      keyError.set(problem);

      return;
    }

    pending.set({ action: "create" });
    keyError.set("");
    hideKey();

    try {
      const { key } = await api<{ key: string }>(
        "/api/account/createApiKey",
        createKeyBody(draft(), label)
      );

      revealKey(key);
      keyModal.set(false);
      await reload();
    } catch (error) {
      keyError.set(errorMessage(error));
    } finally {
      pending.set(null);
    }
  };

  /** Is this row's revoke the action in flight? */
  const isRevoking = (keyId: string): boolean => {
    const current = pending();

    return (
      current !== null && current.action === "revoke" && current.id === keyId
    );
  };

  const revoke = async (keyId: string) => {
    pending.set({ action: "revoke", id: keyId });
    keyError.set("");

    try {
      const result = await authClient.apiKey.delete({ keyId });

      if (result.error) {
        keyError.set(result.error.message ?? "Failed to revoke API key");

        return;
      }

      hideKey();
      await reload();
    } catch (error) {
      keyError.set(errorMessage(error));
    } finally {
      pending.set(null);
    }
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

  if (keysRes.state()._tag === "Loading") {
    return <SectionSkeleton lines={4} />;
  }

  return (
    <div class="flex flex-col gap-4">
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
      <PasskeysCard />
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        <div class="flex items-center justify-between gap-2">
          <h2 class="m-0 text-lg font-semibold">API keys</h2>
          <button
            type="button"
            class="btn btn-sm btn-neutral shrink-0"
            onclick={() => {
              keyName.set("");
              draft.set(newKeyDraft());
              keyError.set("");
              keyModal.set(true);
            }}
          >
            Create key
          </button>
        </div>
        <p class="m-0 text-sm opacity-80">
          Use a key as the Git HTTPS password (<code>username=git</code>), for
          the MCP endpoint, or for event ingest. A key acts as you and never
          above its own scope, role ceiling or expiry. Events-only keys can't
          push code.
        </p>
        <CreateKeyDialog
          apps={apps}
          busy={busy()}
          draft={draft()}
          error={keyError()}
          everyAppId={everyAppId}
          name={keyName()}
          onDraft={(next) => {
            draft.set(next);
          }}
          onName={(next) => {
            keyName.set(next);
          }}
          onSubmit={createKey}
          open={keyModal}
        />
        {freshKey() ? (
          <div class="bg-base-200 flex flex-col gap-2 rounded p-3 text-xs">
            <p class="m-0 font-medium">Copy now — shown once:</p>
            <code class="break-all">{freshKey()}</code>
            <p class="m-0 opacity-70">
              It disappears from this page after ten minutes; the agent snippets
              below fall back to a placeholder when it does.
            </p>
            <button
              type="button"
              class="btn btn-sm btn-ghost w-fit"
              onclick={hideKey}
            >
              Done — hide it
            </button>
          </div>
        ) : null}
        {keyError() ? <p class="text-error m-0 text-sm">{keyError()}</p> : null}
        {keyError() ? null : (
          <LoadError
            error={resourceError(keysRes.state())}
            label="Failed to list API keys"
          />
        )}
        {keys.length === 0 ? (
          <p class="m-0 text-sm opacity-70">No API keys yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {keys.map((row) => (
              <KeyRow
                key={row.id}
                appNames={appNames}
                busy={busy()}
                onRevoke={revoke}
                revoking={isRevoking(row.id)}
                row={row}
              />
            ))}
          </ul>
        )}
      </section>
      <MyInvitesCard />
      <ConnectAgentCard apiKey={freshKey} />
    </div>
  );
};
