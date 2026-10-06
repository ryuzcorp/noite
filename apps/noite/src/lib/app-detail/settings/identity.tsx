//! Settings panel: the app's display name.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import type { AppRole } from "../../roles";
import { renameApp } from "../../server/apps.server";
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
  const draftName = atom(name);
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
      err.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <SettingsSection>
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
      ) : (
        <p class="m-0 text-sm opacity-70">Only admins can change the name.</p>
      )}
    </SettingsSection>
  );
};
