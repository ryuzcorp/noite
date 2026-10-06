//! Settings panel: the edge rate limits (per visitor and whole app).

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { limits } from "../../resources";
import type { AppRole } from "../../roles";
import { setLimits } from "../../server/limits.server";
import { LoadError } from "../../ui/load-error";
import { SectionSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

/** How a limit reads when it is left at the platform default. */
const defaultLabel = (rpm: number) =>
  rpm === 0 ? "Default: no limit" : `Default: ${rpm}/min`;

/** An input's text as a limit: empty = the platform default (null), else a
 * whole number of requests per minute. `undefined` = not a valid number. */
const parseRpm = (raw: string): number | null | undefined => {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  return Number(value);
};

/** An input's text: the unsaved edit, else the saved limit (empty = default). */
const shownRpm = (draft: string | null, saved: number | null) =>
  draft ?? (saved === null ? "" : String(saved));

/** Edge rate limits (SPEC, Edge limits): requests per minute the edge lets
 * through to this app, per visitor and in total, before answering 429. The
 * runner writes them into the Caddyfile on its next reconcile. */
export const RateLimitsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = limits(appId);
  const clientDraft = atom<string | null>(null);
  const appDraft = atom<string | null>(null);
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
        <h3 class="m-0 text-lg font-semibold">Rate Limits</h3>
        <LoadError error={res.error()} />
      </SettingsSection>
    );
  }
  const clientText = shownRpm(clientDraft(), current.clientRpm);
  const appText = shownRpm(appDraft(), current.appRpm);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const clientRpm = parseRpm(clientText);
    const appRpm = parseRpm(appText);
    if (clientRpm === undefined || appRpm === undefined) {
      err.set("Limits are whole numbers of requests per minute.");
      return;
    }
    busy.set(true);
    err.set("");
    note.set("");
    try {
      await setLimits({ appId, appRpm, clientRpm });
      clientDraft.set(null);
      appDraft.set(null);
      await res.refetch();
      note.set("Saved. The edge applies it within a few seconds.");
    } catch (error) {
      err.set(errorMessage(error));
    }
    busy.set(false);
  };

  return (
    <SettingsSection>
      <h3 class="m-0 text-lg font-semibold">Rate Limits</h3>
      <p class="m-0 text-sm opacity-70">
        Requests per minute the edge lets through to this app, across all its
        hostnames. Past a limit, visitors get <code>429 Too Many Requests</code>{" "}
        with a <code>Retry-After</code> header. Leave a field empty for the
        platform default, or enter <code>0</code> for no limit.
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      <form class="flex flex-wrap items-end gap-2" onsubmit={save}>
        <fieldset class="fieldset min-w-40 flex-1">
          <label class="label" for="limit-client">
            Per visitor (IP)
          </label>
          <input
            id="limit-client"
            class="input input-sm"
            type="number"
            min="0"
            step="1"
            value={clientText}
            placeholder={
              current.perClient
                ? defaultLabel(current.defaults.clientRpm)
                : "Off on this install"
            }
            disabled={!isAdmin || busy() || !current.perClient}
            oninput={(e) => {
              clientDraft.set(e.currentTarget.value);
            }}
          />
        </fieldset>
        <fieldset class="fieldset min-w-40 flex-1">
          <label class="label" for="limit-app">
            Whole app
          </label>
          <input
            id="limit-app"
            class="input input-sm"
            type="number"
            min="0"
            step="1"
            value={appText}
            placeholder={defaultLabel(current.defaults.appRpm)}
            disabled={!isAdmin || busy()}
            oninput={(e) => {
              appDraft.set(e.currentTarget.value);
            }}
          />
        </fieldset>
        {isAdmin ? (
          <button type="submit" class="btn btn-sm" disabled={busy()}>
            {busy() ? "Saving…" : "Save limits"}
          </button>
        ) : null}
      </form>
      {current.perClient ? null : (
        <p class="m-0 text-sm opacity-70">
          Per-visitor limits are off: this install sits behind a proxy the edge
          does not trust, so every request looks like one visitor. An operator
          enables them with <code>NOITE_TRUSTED_PROXIES</code>.
        </p>
      )}
      {isAdmin ? null : (
        <p class="m-0 text-sm opacity-70">
          Only an app admin can change rate limits.
        </p>
      )}
      {note() ? <p class="m-0 text-sm opacity-70">{note()}</p> : null}
    </SettingsSection>
  );
};
