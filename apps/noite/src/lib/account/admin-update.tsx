//! The `/account` Admin tab's release-check card. State machine:
//! `./settings.machine.ts`; renderer: `./settings-section.tsx`.
import { atom } from "ilha";

import { api } from "../api";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { resourceError, resourceValue } from "../resource";
import { invalidate, keys, updateStatus } from "../resources";
import type { RunnerUpdateStatus } from "../runner";
import { SettingsSection } from "./settings-section";
import { Evt, Settings, syncStatus, transition } from "./settings.machine";
import type { SettingsState } from "./settings.machine";

/** The release-check card: the opt-out that gates the update banner. */
export const UpdateCard = () => {
  const res = updateStatus();
  const status = resourceValue(res.state());
  // The machine lives here, not in a body keyed on the status: the refetch
  // below blanks `status` for a beat, and the save confirmation must survive
  // that (the old cards hoisted individual flags for exactly this reason).
  const machine = atom<SettingsState>(Settings.Loading());
  // Pure fold of this render's answer into the machine: no atom write during
  // render, and the save confirmation survives the refetch that blanks
  // `status` for a beat.
  const model = syncStatus(machine(), status, resourceError(res.state()));

  const save = (value: boolean) => {
    const started = transition(model, Evt.SaveStarted());
    machine.set(started);

    void (async () => {
      try {
        const reply = await api<RunnerUpdateStatus>(
          "/api/update/setUpdateStatus",
          { enabled: value }
        );

        machine.set(
          transition(
            machine(),
            Evt.SaveSucceeded({
              checking: reply.checking,
              status: reply,
              value,
            })
          )
        );
        // The banner and the detail rows come from the runner; the card
        // refetches behind the confirmation.
        invalidate(keys.update);
      } catch (error) {
        machine.set(
          transition(
            machine(),
            Evt.SaveFailed({ message: errorMessage(error) })
          )
        );
      }
    })();
  };

  return (
    <SettingsSection
      check={
        <p class="m-0 text-sm opacity-70">
          Checking for new releases — anything found appears in the banner
          above.
        </p>
      }
      description={
        <p class="m-0 text-sm opacity-80">
          Once a day this instance asks{" "}
          <code class="text-xs">api.github.com</code> for the public release
          list and shows admins a banner when a newer release exists. Nothing
          about this instance is sent — no version, no identifiers. Turn the
          checkbox off to stop checking.
        </p>
      }
      extra={
        status?.checkedAt ? (
          <p class="m-0 text-sm opacity-70">
            Last checked {formatDateTime(status.checkedAt)}
            {status.latest
              ? ` — newest release seen: ${status.latest}`
              : " — up to date"}
          </p>
        ) : null
      }
      id="update-check-enabled"
      label="Check for new Noite releases"
      onSave={save}
      savedMessage="Release check setting saved."
      onToggle={(value) => {
        machine.set(transition(model, Evt.Toggled({ value })));
      }}
      state={model}
      title="Release check"
    />
  );
};
