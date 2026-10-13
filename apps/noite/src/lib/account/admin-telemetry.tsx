import { atom } from "ilha";
import type { AtomHandle } from "ilha";

import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import {
  adminStatus,
  invalidate,
  keys,
  session,
  telemetry,
} from "../resources";
import type { RunnerTelemetryStatus } from "../runner";
import { setTelemetry } from "../server/telemetry.server";
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";

/** "Disabled by NOITE_TELEMETRY=0" — the operator's kill switch. */
const LockNotice = ({ reason }: { reason: string | null }) => (
  <p class="m-0 text-sm opacity-70">Disabled by {reason ?? "the operator"}</p>
);

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

/** The card body, given a status (so the checkbox and lock are always real). */
const TelemetrySettings = ({
  status,
  saved,
}: {
  status: RunnerTelemetryStatus;
  saved: AtomHandle<boolean>;
}) => {
  const busy = atom(false);
  const error = atom("");
  // Unsaved checkbox edit; null = untouched, so the box follows the runner
  // (including after the refetch below). Controlled input, reset via atom.
  const draft = atom<boolean | null>(null);

  const { locked } = status;
  // Locked means effective is off, whatever the stored preference says.
  const enabled = locked ? false : (draft() ?? status.enabled);

  const save = async () => {
    busy.set(true);
    error.set("");
    try {
      await setTelemetry({ enabled });
      draft.set(null);
      saved.set(true);
      // Detail rows (last sent, payload, effective state) come from the
      // runner; the live card refetches behind the confirmation.
      invalidate(keys.telemetry);
    } catch (saveError) {
      error.set(errorMessage(saveError));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
      <h2 class="m-0 text-lg font-semibold">Telemetry</h2>
      <div class="flex flex-col gap-1">
        <p class="m-0 text-sm font-medium">Anonymous usage telemetry</p>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input
            id="telemetry-enabled"
            type="checkbox"
            class="checkbox checkbox-sm"
            checked={enabled}
            disabled={locked || busy()}
            onchange={(event) => {
              draft.set(event.currentTarget.checked);
              saved.set(false);
            }}
          />
          Share anonymous instance telemetry
        </label>
        {locked ? <LockNotice reason={status.lockReason} /> : null}
      </div>
      <p class="m-0 text-sm opacity-80">
        Once a day this instance sends Noite's maintainers a count-only summary
        (version, platform, number of apps, deploys and users). No domains,
        names, emails or IPs.{" "}
        <a
          class="link"
          href="https://noite.now/self-hosting/telemetry"
          target="_blank"
          rel="noopener"
        >
          What's sent
        </a>
      </p>
      {status.lastSentAt ? (
        <p class="m-0 text-sm opacity-70">
          Last sent {formatDateTime(status.lastSentAt)}
        </p>
      ) : null}
      <PayloadDisclosure preview={status.preview} />
      {error() ? <p class="text-error m-0 text-sm">{error()}</p> : null}
      {saved() ? (
        <p class="text-success m-0 text-sm">Telemetry setting saved.</p>
      ) : null}
      <div>
        <button
          type="button"
          class="btn btn-sm btn-neutral"
          disabled={busy() || locked}
          onclick={() => {
            void save();
          }}
        >
          {busy() ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
};

/** The `/account` Admin tab's card: the anonymous instance-telemetry opt-out. */
export const TelemetryCard = () => {
  const res = telemetry();
  const status = res.data();
  // Lives here, not in the body: the invalidate below blanks `status` for a
  // beat and remounts the body, which must keep the save confirmation.
  const saved = atom(false);
  if (res.loading() && status === undefined) {
    return <SectionSkeleton lines={3} />;
  }
  if (status === undefined) {
    return (
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        <h2 class="m-0 text-lg font-semibold">Telemetry</h2>
        <LoadError
          error={res.error()}
          label="Failed to load telemetry settings"
        />
      </section>
    );
  }
  return <TelemetrySettings saved={saved} status={status} />;
};

/** A real (non-impersonating) instance admin, once both resources load. Gates
 * the `/account` Admin tab; the actions behind it re-check the same gate
 * server-side, so hiding the tab is presentation, not security. */
export const isInstanceAdmin = (): boolean => {
  const admin = adminStatus().data();
  const sess = session().data();
  return (admin?.isAdmin ?? false) && sess?.session.impersonatedBy === null;
};
