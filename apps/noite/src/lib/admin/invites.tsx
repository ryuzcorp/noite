//! Admin tab: the invite pool — search it, mint codes, revoke what is open.

import { atom } from "ilha";
import type { View } from "ilha";

import { errorMessage } from "../errors";
import { adminListInvites } from "../resources";
import { searchParam } from "../search-param";
import { adminCreateInvites, adminRevokeInvite } from "../server/admin.server";
import { Avatar } from "../ui/avatar";
import { CopyButton } from "../ui/copy-button";
import {
  ACTION,
  AdminRow,
  DANGER,
  EMPTY_ROW,
  PanelCard,
  Problems,
  SearchForm,
  SkeletonRows,
  W_SM,
} from "./shared";

interface AdminInvite {
  code: string;
  createdAt: string;
  createdByEmail: string;
  id: string;
  revoked: boolean;
  usedAt: string;
  usedByEmail: string;
}

const inviteState = (row: AdminInvite): string => {
  if (row.usedByEmail) {
    return `used by ${row.usedByEmail}`;
  }
  return row.revoked ? "revoked" : "available";
};

const inviteTone = (row: AdminInvite): string => {
  if (row.usedByEmail) {
    return "status-neutral";
  }
  return row.revoked ? "status-error" : "status-success";
};

const InviteRow = (props: {
  busy: boolean;
  inv: AdminInvite;
  onRevoke: (id: string) => void;
}) => {
  const { inv } = props;
  const open = !(inv.usedByEmail || inv.revoked);
  return (
    <AdminRow
      avatar={
        <Avatar
          label={inv.createdByEmail || inv.code}
          status={inviteState(inv)}
          tone={inviteTone(inv)}
        />
      }
      actions={
        <>
          <CopyButton
            class={`${ACTION} ${W_SM} gap-1`}
            label="Copy invite code"
            value={inv.code}
          />
          {/* Always rendered, hidden once the code is spent: Copy keeps its
              place instead of sliding right on those rows. */}
          <button
            type="button"
            class={`${DANGER} ${W_SM} ${open ? "" : "invisible"}`}
            disabled={props.busy || !open}
            aria-hidden={open ? "false" : "true"}
            tabindex={open ? 0 : -1}
            onclick={() => {
              props.onRevoke(inv.id);
            }}
          >
            Revoke
          </button>
        </>
      }
    >
      <code class="font-mono text-sm">{inv.code}</code>
      <div class="truncate text-xs opacity-70">
        {inviteState(inv)} · from {inv.createdByEmail}
      </div>
    </AdminRow>
  );
};

/** The invite pool: search it, mint codes, hand them out, revoke what is still
 * open. The search (`?iq=`) matches the code, who made it and who used it. */
export const AdminInvitesPanel = () => {
  const busy = atom(false);
  const res = adminListInvites();
  const invites = res.data() ?? [];
  const loadError = res.error();
  const panelError = atom("");
  const mintCount = atom(3);
  const search = searchParam("iq", { default: "" });
  const needle = search().trim().toLowerCase();
  const shown = needle
    ? invites.filter((inv) =>
        [inv.code, inv.createdByEmail, inv.usedByEmail, inviteState(inv)].some(
          (field) => field.toLowerCase().includes(needle)
        )
      )
    : invites;

  const reload = () => res.refetch();

  const mint = async () => {
    busy.set(true);
    panelError.set("");
    try {
      await adminCreateInvites({ count: Number(mintCount()) });
      await reload();
    } catch (error) {
      panelError.set(errorMessage(error));
    }
    busy.set(false);
  };

  const revoke = async (id: string) => {
    busy.set(true);
    panelError.set("");
    try {
      await adminRevokeInvite(id);
      await reload();
    } catch (error) {
      panelError.set(errorMessage(error));
    }
    busy.set(false);
  };

  const loading = res.loading() && res.data() === undefined;
  let body: View;
  if (loading) {
    body = <SkeletonRows />;
  } else if (shown.length === 0) {
    body = (
      <li class={EMPTY_ROW}>
        {needle ? "No codes match that search." : "No codes yet."}
      </li>
    );
  } else {
    body = (
      <>
        {shown.map((inv) => (
          <InviteRow
            key={inv.id}
            inv={inv}
            busy={busy()}
            onRevoke={(id) => {
              void revoke(id);
            }}
          />
        ))}
      </>
    );
  }
  return (
    <PanelCard
      title="Invites"
      note="Registration is invite-only. Every new account receives 2 codes of its own to hand out."
      controls={
        <SearchForm
          id="admin-invite-search"
          label="Search invites by code or email"
          placeholder="Search by code or email"
          value={search()}
          onSearch={(value) => {
            search.set(value);
          }}
        />
      }
    >
      <Problems load={loadError} panel={panelError()} />
      {body}
      <li class="flex items-center justify-end gap-2 p-4 pt-2">
        <label class="label text-xs opacity-70" for="invite-count">
          codes
        </label>
        <input
          id="invite-count"
          type="number"
          min="1"
          max="50"
          class="input input-sm w-20"
          value={mintCount()}
          oninput={(e) => {
            mintCount.set(Number(e.currentTarget.value));
          }}
        />
        <button
          type="button"
          class={ACTION}
          disabled={busy()}
          onclick={() => {
            void mint();
          }}
        >
          Generate
        </button>
      </li>
    </PanelCard>
  );
};
