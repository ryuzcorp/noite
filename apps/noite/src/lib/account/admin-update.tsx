import { atom } from "ilha";
import type { AtomHandle } from "ilha";

import { api } from "../api";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { invalidate, keys, updateStatus } from "../resources";
import type { RunnerUpdateStatus } from "../runner";
import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";

/** "Disabled by NOITE_UPDATE_CHECK=off" — the operator's force-off. */
const LockNotice = ({ reason }: { reason: string | null }) => (
  <p class="m-0 text-sm opacity-70">Disabled by {reason ?? "the operator"}</p>
);

/** The card body, given a status (so the checkbox and lock are always real). */
const UpdateSettings = ({
  checking,
  status,
  saved,
}: {
  checking: AtomHandle<boolean>;
  status: RunnerUpdateStatus;
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
      const reply = await api<RunnerUpdateStatus>(
        "/api/update/setUpdateStatus",
        {
          enabled,
        }
      );

      draft.set(null);
      saved.set(true);
      // The set reply says whether a background check is now in flight; the
      // card shows "Checking…" until the next normal load picks up its result.
      checking.set(reply.checking);
      // The banner and the detail rows come from the runner; the live card
      // refetches behind the confirmation.
      invalidate(keys.update);
    } catch (saveError) {
      error.set(errorMessage(saveError));
    } finally {
      busy.set(false);
    }
  };

  return (
    <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
      <h2 class="m-0 text-lg font-semibold">Release check</h2>
      <div class="flex flex-col gap-1">
        <p class="m-0 text-sm font-medium">Check for new releases</p>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input
            id="update-check-enabled"
            type="checkbox"
            class="checkbox checkbox-sm"
            checked={enabled}
            disabled={locked || busy()}
            onchange={(event) => {
              draft.set(event.currentTarget.checked);
              saved.set(false);
              checking.set(false);
            }}
          />
          Check for new Noite releases
        </label>
        {locked ? <LockNotice reason={status.lockReason} /> : null}
      </div>
      <p class="m-0 text-sm opacity-80">
        Once a day this instance asks{" "}
        <code class="text-xs">api.github.com</code> for the public release list
        and shows admins a banner when a newer release exists. Nothing about
        this instance is sent — no version, no identifiers. Turn the checkbox
        off to stop checking.
      </p>
      {status.checkedAt ? (
        <p class="m-0 text-sm opacity-70">
          Last checked {formatDateTime(status.checkedAt)}
          {status.latest
            ? ` — newest release seen: ${status.latest}`
            : " — up to date"}
        </p>
      ) : null}
      {error() ? <p class="text-error m-0 text-sm">{error()}</p> : null}
      {saved() ? (
        <p class="text-success m-0 text-sm">Release check setting saved.</p>
      ) : null}
      {checking() ? (
        <p class="m-0 text-sm opacity-70">
          Checking for new releases — the banner appears above if one is found.
        </p>
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

/** The `/account` Admin tab's card: the opt-out release check. */
export const UpdateCard = () => {
  const res = updateStatus();
  const status = res.data();
  // Lives here, not in the body: the invalidate below blanks `status` for a
  // beat and remounts the body, which must keep the save confirmation.
  const saved = atom(false);
  const checking = atom(false);

  if (res.loading() && status === undefined) {
    return <SectionSkeleton lines={3} />;
  }

  if (status === undefined) {
    return (
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        <h2 class="m-0 text-lg font-semibold">Release check</h2>
        <LoadError
          error={res.error()}
          label="Failed to load release check settings"
        />
      </section>
    );
  }

  return <UpdateSettings checking={checking} saved={saved} status={status} />;
};
