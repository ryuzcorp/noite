//! Settings panel: the app's collaborators and its pending invitations.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { collaborators, pendingInvitations } from "../../resources";
import { parseAppRole } from "../../roles";
import type { AppRole } from "../../roles";
import {
  inviteCollaborator,
  removeCollaborator,
  revokeInvitation,
  updateCollaboratorRole,
} from "../../server/collaborators.server";
import { Dialog } from "../../ui/dialog";
import { LoadError } from "../../ui/load-error";
import { ListSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

export const CollaboratorsPanel = ({
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
    <SettingsSection>
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
            <code>push</code> deploy, push code, write data · <code>admin</code>{" "}
            members, variables, delete.
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
    </SettingsSection>
  );
};
