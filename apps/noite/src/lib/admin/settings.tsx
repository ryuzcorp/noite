//! Settings section of the control app's Admin tab
//! (`/apps/_control?t=admin`): the instance-wide switches, in the one place
//! every other admin surface lives. Three cards, one machine: the
//! anonymous-telemetry opt-out, the release check (`./settings.machine.ts`,
//! rendered by `./settings-section.tsx`) and the registration waitlist. All
//! actions re-check instance admin server-side, so this page is
//! presentation, not the gate.

import { atom } from "ilha";

import { api } from "../api";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { resourceError, resourceValue } from "../resource";
import {
  invalidate,
  keys,
  telemetry,
  updateStatus,
  waitlist,
} from "../resources";
import type { RunnerTelemetryStatus, RunnerUpdateStatus } from "../runner";
import { SettingsSection } from "./settings-section";
import { Evt, Settings, syncStatus, transition } from "./settings.machine";
import type { SettingsState, SettingStatus } from "./settings.machine";

/** The payload the runner would POST right now, minus the write-only PostHog
 * key (public-safe, but it has no place on the page). */
const PayloadDisclosure = ({
  preview,
}: {
  preview: RunnerTelemetryStatus["preview"];
}) => (
  <details>
    <summary class="cursor-pointer text-sm">Show the exact payload</summary>
    <pre class="bg-base-200 mt-2 overflow-auto rounded p-3 text-xs">
      {JSON.stringify(
        preview,
        (key, value) => (key === "api_key" ? undefined : value),
        2
      )}
    </pre>
  </details>
);

/** The anonymous instance-telemetry opt-out. */
const TelemetryCard = () => {
  const res = telemetry();
  const status = resourceValue(res.state());
  const machine = atom<SettingsState>(Settings.Loading());
  const model = syncStatus(machine(), status, resourceError(res.state()));

  const save = (value: boolean) => {
    machine.set(transition(model, Evt.SaveStarted()));

    void (async () => {
      try {
        const reply = await api<RunnerTelemetryStatus>(
          "/api/telemetry/setTelemetry",
          { enabled: value }
        );

        machine.set(
          transition(
            machine(),
            Evt.SaveSucceeded({
              checking: false,
              status: reply,
              value,
            })
          )
        );
        // Detail rows (last sent, payload, effective state) come from the
        // runner; the card refetches behind the confirmation.
        invalidate(keys.telemetry);
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
      description={
        <p class="m-0 text-sm opacity-80">
          Once a day this instance sends Noite's maintainers a count-only
          summary (version, platform, number of apps, deploys and users). No
          domains, names, emails or IPs.{" "}
          <a
            class="link"
            href="https://noite.now/self-hosting/telemetry"
            target="_blank"
            rel="noopener"
          >
            What's sent
          </a>
        </p>
      }
      extra={
        status ? (
          <>
            {status.lastSentAt ? (
              <p class="m-0 text-sm opacity-70">
                Last sent {formatDateTime(status.lastSentAt)}
              </p>
            ) : null}
            <PayloadDisclosure preview={status.preview} />
          </>
        ) : null
      }
      id="telemetry-enabled"
      label="Share anonymous instance telemetry"
      onSave={save}
      savedMessage="Telemetry setting saved."
      onToggle={(value) => {
        machine.set(transition(model, Evt.Toggled({ value })));
      }}
      state={model}
      title="Telemetry"
    />
  );
};

/** The release-check card: the opt-out that gates the update banner. */
const UpdateCard = () => {
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

/** The registration waitlist: uninvited registrations queue as `pending`
 * (an admin approves them on the Users tab) instead of being refused. The
 * machine is shared with the runner-backed cards; the status is folded from
 * the D1-backed answer (`locked` never applies — the switch is local). */
const WaitlistCard = () => {
  const res = waitlist();
  const reply = resourceValue(res.state());

  // The machine speaks `SettingStatus`; the waitlist answer is just the
  // switch, so the fold names the stored value twice and never locks.
  const status: SettingStatus | undefined =
    reply === undefined
      ? undefined
      : {
          enabled: reply.enabled,
          locked: false,
          lockReason: null,
          setting: reply.enabled,
        };

  const machine = atom<SettingsState>(Settings.Loading());
  const model = syncStatus(machine(), status, resourceError(res.state()));

  const save = (value: boolean) => {
    machine.set(transition(model, Evt.SaveStarted()));

    void (async () => {
      try {
        const saved = await api<{ enabled: boolean }>(
          "/api/admin/setWaitlist",
          { enabled: value }
        );

        const next: SettingStatus = {
          enabled: saved.enabled,
          locked: false,
          lockReason: null,
          setting: saved.enabled,
        };

        machine.set(
          transition(
            machine(),
            Evt.SaveSucceeded({ checking: false, status: next, value })
          )
        );
        invalidate(keys.waitlist);
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
      description={
        <p class="m-0 text-sm opacity-80">
          With the waitlist on, someone who registers without an invitation
          waits for approval instead of being turned away: their account holds
          no access until an admin approves it on the Users tab. With it off
          (the default), uninvited registration is refused outright.
        </p>
      }
      id="waitlist-enabled"
      label="Queue uninvited registrations for approval"
      onSave={save}
      savedMessage="Waitlist setting saved."
      onToggle={(value) => {
        machine.set(transition(model, Evt.Toggled({ value })));
      }}
      state={model}
      title="Registration waitlist"
    />
  );
};

/** The Admin tab's settings section: instance-wide switches, stacked like
 * the app-detail settings sections. Nothing here is per app. */
export const AdminSettingsPanel = () => (
  <div class="flex flex-col gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">Instance settings</h2>
      <p class="m-0 text-sm opacity-70">
        These switches apply to the whole install, not to one app.
      </p>
    </div>
    <TelemetryCard />
    <UpdateCard />
    <WaitlistCard />
  </div>
);
