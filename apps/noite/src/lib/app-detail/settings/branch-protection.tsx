//! Settings panel: branch protection for `main` (`require_pr` plus the
//! number of approvals a merge needs). Admin-only; the panel is mounted
//! inside the settings stack's admin gate, and the fields self-disable.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import type { AppRole } from "../../roles";
import { branchRulesSet } from "../../server/prs.server";
import { branchRules } from "../../source/branch-rules";
import { LoadError } from "../../ui/load-error";
import { SectionSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

/** The runner accepts 0–2 required approvals (`0` = no approval needed). */
const APPROVAL_CHOICES = [0, 1, 2] as const;

/** Branch protection for `main`: with `require_pr` on, only admins may push
 * to `main` directly — everyone else opens a pull. */
export const BranchProtectionPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = branchRules(appId);
  const requireDraft = atom<boolean | null>(null);
  const approvalsDraft = atom<number | null>(null);
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
      <SettingsSection>
        <h3 class="m-0 text-lg font-semibold">Branch protection</h3>
        <LoadError error={res.error()} />
      </SettingsSection>
    );
  }
  const requirePr = requireDraft() ?? current.requirePr;
  const approvals = approvalsDraft() ?? current.requiredApprovals;

  const save = async () => {
    if (!isAdmin || busy()) {
      return;
    }
    busy.set(true);
    err.set("");
    note.set("");
    try {
      await branchRulesSet({
        appId,
        requirePr,
        requiredApprovals: approvals,
      });
      requireDraft.set(null);
      approvalsDraft.set(null);
      await res.refetch();
      note.set("Saved.");
    } catch (error) {
      err.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <SettingsSection>
      <h3 class="m-0 text-lg font-semibold">Branch protection</h3>
      <p class="m-0 text-sm opacity-70">
        With <code>require_pr</code> on, only admins can push to{" "}
        <code>main</code> directly: everyone else commits to a branch and opens
        a pull. Merges then need the number of approvals set below.
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      <div class="flex flex-wrap items-end gap-6">
        <label
          class="label cursor-pointer justify-start gap-3"
          for="branch-require-pr"
        >
          <input
            id="branch-require-pr"
            type="checkbox"
            class="toggle toggle-sm"
            checked={requirePr}
            disabled={!isAdmin || busy()}
            onchange={(e) => {
              requireDraft.set(e.currentTarget.checked);
            }}
          />
          <span class="text-sm">
            Require a pull before merging into <code>main</code>
          </span>
        </label>
        <fieldset class="fieldset w-40">
          <label class="label" for="branch-approvals">
            Required approvals
          </label>
          <select
            id="branch-approvals"
            class="select select-sm"
            value={String(approvals)}
            disabled={!isAdmin || busy()}
            onchange={(e) => {
              approvalsDraft.set(Number(e.currentTarget.value));
            }}
          >
            {APPROVAL_CHOICES.map((choice) => (
              <option
                key={choice}
                value={String(choice)}
                selected={choice === approvals}
              >
                {choice}
              </option>
            ))}
          </select>
        </fieldset>
        {isAdmin ? (
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy()}
            onclick={() => {
              void save();
            }}
          >
            {busy() ? "Saving…" : "Save branch rules"}
          </button>
        ) : null}
      </div>
      {isAdmin ? null : (
        <p class="m-0 text-sm opacity-70">
          Only an app admin can change branch protection.
        </p>
      )}
      {note() ? <p class="m-0 text-sm opacity-70">{note()}</p> : null}
    </SettingsSection>
  );
};
