//! Settings view: the app's display name.

import { atom } from "ilha";

import { api } from "../../api";
import { errorMessage } from "../../errors";
import type { AppRole } from "../../roles";
import { capabilities } from "../capabilities";
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

/** Identity form: the display name. Admin-only; everyone else sees the
 * read-only value. The slug is not here: changing it moves the app's URL and
 * git remote, so it lives in the Danger Zone. */
export const AppIdentityForm = ({
  appId,
  name,
  myRole,
  onSaved,
}: {
  appId: string;
  name: string;
  myRole: AppRole;
  onSaved: () => void;
}) => {
  const form = atom<DraftForm<string>>(draftForm(name));
  const isAdmin = capabilities(myRole).admin;

  const saveName = async () => {
    if (!isAdmin || formBusy(form())) {
      return;
    }

    const next = form().draft.trim();

    if (!next) {
      form.set(failedDraft(form(), "Name is required"));

      return;
    }

    form.set(savingDraft(form()));

    try {
      await api<{ ok: true }>("/api/apps/renameApp", { id: appId, name: next });
      form.set(savedDraft(form(), next));
      onSaved();
    } catch (error) {
      form.set(failedDraft(form(), errorMessage(error)));
    }
  };

  const failure = form().status;

  return (
    <SettingsSection section="identity">
      {failure._tag === "Failed" ? (
        <p class="text-error m-0 text-sm">{failure.error}</p>
      ) : null}
      <fieldset class="fieldset w-full">
        <label class="label" for="identity-name">
          Name
        </label>
        <input
          id="identity-name"
          class="input input-sm"
          value={form().draft}
          disabled={!isAdmin || formBusy(form())}
          placeholder="My Service"
          oninput={(e) => {
            form.set(editDraft(form(), e.currentTarget.value));
          }}
        />
      </fieldset>
      {isAdmin ? (
        <div>
          <button
            type="button"
            class="btn btn-sm"
            disabled={formBusy(form()) || !formCanSave(form())}
            onclick={() => {
              void saveName();
            }}
          >
            {formBusy(form()) ? "Saving…" : "Save name"}
          </button>
        </div>
      ) : (
        <p class="m-0 text-sm opacity-70">Only admins can change the name.</p>
      )}
    </SettingsSection>
  );
};
