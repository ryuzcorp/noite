//! Settings panel: branch protection for `main` (`require_pr` plus the
//! number of approvals a merge needs). Admin-only; the panel is mounted
//! inside the settings stack's admin gate, and the fields self-disable.

import { atom } from "ilha";

import { api } from "../../api";
import { errorMessage } from "../../errors";
import { resourceValue, resourceError } from "../../resource";
import type { AppRole } from "../../roles";
import type { BranchRules } from "../../runner";
import { branchRules } from "../../source/branch-rules";
import { LoadError } from "../../ui/load-error";
import { SectionSkeleton } from "../../ui/skeletons";
import { capabilities } from "../capabilities";
import { watchResource } from "../watch-resource";
import {
  draftForm,
  editDraft,
  failedDraft,
  formBusy,
  formCanSave,
  savedDraft,
  savingDraft,
} from "./draft";
import type { DraftForm } from "./draft";
import { SettingsSection } from "./section";

/** The runner accepts 0–2 required approvals (`0` = no approval needed). */
const APPROVAL_CHOICES = [0, 1, 2] as const;

interface RulesDraft {
  readonly approvals: number;
  readonly requirePr: boolean;
}

const toDraft = (rules: BranchRules): RulesDraft => ({
  approvals: rules.requiredApprovals,
  requirePr: rules.requirePr,
});

const sameDraft = (a: RulesDraft, b: RulesDraft): boolean =>
  a.approvals === b.approvals && a.requirePr === b.requirePr;

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
  const current = resourceValue(res.state());

  const form = atom<DraftForm<RulesDraft>>(
    draftForm(current ? toDraft(current) : { approvals: 0, requirePr: false })
  );

  const isAdmin = capabilities(myRole).admin;

  // A refetch after a save moves the baseline; a dirty form keeps its edits.
  watchResource(res.state, (state) => {
    const fresh = resourceValue(state);

    if (fresh && form().status._tag !== "Dirty") {
      form.set(draftForm(toDraft(fresh)));
    }
  });

  if (res.state()._tag === "Loading") {
    return <SectionSkeleton lines={2} />;
  }

  if (!current) {
    return (
      <SettingsSection>
        <h3 class="m-0 text-lg font-semibold">Branch protection</h3>
        <LoadError error={resourceError(res.state())} />
      </SettingsSection>
    );
  }

  const { draft } = form();
  const busy = formBusy(form());
  const failure = form().status;

  const save = async () => {
    if (!isAdmin || busy) {
      return;
    }

    form.set(savingDraft(form()));

    try {
      await api<BranchRules>("/api/prs/branchRulesSet", {
        appId,
        requirePr: draft.requirePr,
        requiredApprovals: draft.approvals,
      });
      form.set(savedDraft(form(), draft));
      await res.refetch();
    } catch (error) {
      form.set(failedDraft(form(), errorMessage(error)));
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
      {failure._tag === "Failed" ? (
        <p class="text-error m-0 text-sm">{failure.error}</p>
      ) : null}
      <div class="flex flex-wrap items-end gap-6">
        <label
          class="label cursor-pointer justify-start gap-3"
          for="branch-require-pr"
        >
          <input
            id="branch-require-pr"
            type="checkbox"
            class="toggle toggle-sm"
            checked={draft.requirePr}
            disabled={!isAdmin || busy}
            onchange={(e) => {
              form.set(
                editDraft(
                  form(),
                  { ...draft, requirePr: e.currentTarget.checked },
                  sameDraft
                )
              );
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
            value={String(draft.approvals)}
            disabled={!isAdmin || busy}
            onchange={(e) => {
              form.set(
                editDraft(
                  form(),
                  { ...draft, approvals: Number(e.currentTarget.value) },
                  sameDraft
                )
              );
            }}
          >
            {APPROVAL_CHOICES.map((choice) => (
              <option
                key={choice}
                value={String(choice)}
                selected={choice === draft.approvals}
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
            disabled={busy || !formCanSave(form())}
            onclick={() => {
              void save();
            }}
          >
            {busy ? "Saving…" : "Save branch rules"}
          </button>
        ) : null}
      </div>
      {isAdmin ? null : (
        <p class="m-0 text-sm opacity-70">
          Only an app admin can change branch protection.
        </p>
      )}
      {failure._tag === "Saved" ? (
        <p class="m-0 text-sm opacity-70">Saved.</p>
      ) : null}
    </SettingsSection>
  );
};
