import { atom } from "ilha";

import { api } from "../api";
import { mayAdministerInstance, overviewAuthority } from "../authority";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { resourceError, resourceValue } from "../resource";
import { adminStatus, invalidate, keys, telemetry } from "../resources";
import type { RunnerTelemetryStatus } from "../runner";
import { SettingsSection } from "./settings-section";
import { Evt, Settings, syncStatus, transition } from "./settings.machine";
import type { SettingsState } from "./settings.machine";

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

/** The `/account` Admin tab's card: the anonymous instance-telemetry
 * opt-out. State machine: `./settings.machine.ts`; renderer:
 * `./settings-section.tsx` (shared with the release check). */
export const TelemetryCard = () => {
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

/** May this session administer the instance? One shared predicate
 * (`mayAdministerInstance` over the overview's authority), the same one the
 * side bar, the control page and every server gate ask. Gates the `/account`
 * Admin tab; the actions behind it re-check server-side, so hiding the tab is
 * presentation, not security. */
export const isInstanceAdmin = (): boolean =>
  mayAdministerInstance(
    overviewAuthority(resourceValue(adminStatus().state()))
  );
