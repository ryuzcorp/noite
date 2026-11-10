//! Settings view: the edge rate limits (per visitor and whole app) and the
//! fleet's memory cap. One draft-over-saved form (`draft.ts`): the draft
//! survives an edit, a save makes it the baseline, and a failure keeps the
//! user's input while painting why.

import { atom } from "ilha";

import { api } from "../../api";
import { errorMessage } from "../../errors";
import { resourceValue, resourceError } from "../../resource";
import { limits } from "../../resources";
import type { AppRole } from "../../roles";
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
  rebaseDraft,
  savedDraft,
  savingDraft,
} from "./draft";
import type { DraftForm } from "./draft";
import { SettingsSection } from "./section";

/** How a limit reads when it is left at the platform default. */
const defaultLabel = (rpm: number) =>
  rpm === 0 ? "Default: no limit" : `Default: ${rpm}/min`;

/** An input's text as a limit: empty = the platform default (null), else a
 * whole number. `undefined` = not a valid number. */
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

/** The sleep default's placeholder, in the largest exact unit. */
const sleepPlaceholder = (seconds: number): string => {
  if (seconds === 0) {
    return "Default: never";
  }

  if (seconds % 3600 === 0) {
    return `Default: ${seconds / 3600} h`;
  }

  return `Default: ${seconds} s`;
};

/** The four inputs parsed, or the one validation sentence an invalid input
 * paints (all four fields are checked at once, like the form shows them). */
const parseLimits = (
  draft: LimitsDraft
):
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly value: {
        appRpm: number | null;
        clientRpm: number | null;
        memoryMb: number | null;
        sleepAfterS: number | null;
      };
    } => {
  const clientRpm = parseRpm(draft.clientRpm);
  const appRpm = parseRpm(draft.appRpm);
  const memoryMb = parseRpm(draft.memoryMb);
  const sleepAfterS = parseRpm(draft.sleepAfterS);

  if (
    clientRpm === undefined ||
    appRpm === undefined ||
    memoryMb === undefined ||
    sleepAfterS === undefined
  ) {
    return { ok: false };
  }

  return { ok: true, value: { appRpm, clientRpm, memoryMb, sleepAfterS } };
};

/** The four inputs as one draft; saves compare drafts, never atoms. */
interface LimitsDraft {
  readonly appRpm: string;
  readonly clientRpm: string;
  readonly memoryMb: string;
  readonly sleepAfterS: string;
}

const toDraft = (saved: {
  appRpm: number | null;
  clientRpm: number | null;
  memoryMb: number | null;
  sleepAfterS: number | null;
}): LimitsDraft => ({
  appRpm: saved.appRpm === null ? "" : String(saved.appRpm),
  clientRpm: saved.clientRpm === null ? "" : String(saved.clientRpm),
  memoryMb: saved.memoryMb === null ? "" : String(saved.memoryMb),
  sleepAfterS: saved.sleepAfterS === null ? "" : String(saved.sleepAfterS),
});

const sameDraft = (a: LimitsDraft, b: LimitsDraft): boolean =>
  a.appRpm === b.appRpm &&
  a.clientRpm === b.clientRpm &&
  a.memoryMb === b.memoryMb &&
  a.sleepAfterS === b.sleepAfterS;

/** Limits (SPEC, Edge limits and Tenant isolation): requests per minute the
 * edge lets through to this app, per visitor and in total, before answering
 * 429 — plus this fleet's memory cap in MiB, the `memory.max` of its own
 * cgroup. The runner writes rate limits into the Caddyfile on its next
 * reconcile; a memory cap applies when the fleet next spawns. */
export const RateLimitsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = limits(appId);
  const current = resourceValue(res.state());

  const blank: LimitsDraft = {
    appRpm: "",
    clientRpm: "",
    memoryMb: "",
    sleepAfterS: "",
  };

  const form = atom<DraftForm<LimitsDraft>>(
    draftForm(current ? toDraft(current) : blank)
  );

  const isAdmin = capabilities(myRole).admin;

  // A refetch after a save (or a concurrent change) moves the baseline; a
  // dirty form keeps the user's edits.
  watchResource(res.state, (state) => {
    const fresh = resourceValue(state);

    if (!fresh) {
      return;
    }

    const next = toDraft(fresh);

    if (form().status._tag !== "Dirty") {
      form.set(rebaseDraft(form(), next));
    }
  });

  if (res.state()._tag === "Loading") {
    return <SectionSkeleton lines={2} />;
  }

  if (!current) {
    return (
      <SettingsSection>
        <h3 class="m-0 text-lg font-semibold">Limits</h3>
        <LoadError error={resourceError(res.state())} />
      </SettingsSection>
    );
  }

  const { draft } = form();
  const busy = formBusy(form());

  const edit = (patch: Partial<LimitsDraft>): void => {
    form.set(editDraft(form(), { ...draft, ...patch }, sameDraft));
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = parseLimits(draft);

    if (!parsed.ok) {
      form.set(
        failedDraft(
          form(),
          "Limits are whole numbers — requests per minute, MiB for memory, seconds for sleep."
        )
      );

      return;
    }

    const { appRpm, clientRpm, memoryMb, sleepAfterS } = parsed.value;

    form.set(savingDraft(form()));

    try {
      await api<{ ok: true }>("/api/limits/setLimits", {
        appId,
        appRpm,
        clientRpm,
        memoryMb,
        sleepAfterS,
      });
      form.set(
        savedDraft(form(), {
          appRpm: appRpm === null ? "" : String(appRpm),
          clientRpm: clientRpm === null ? "" : String(clientRpm),
          memoryMb: memoryMb === null ? "" : String(memoryMb),
          sleepAfterS: sleepAfterS === null ? "" : String(sleepAfterS),
        })
      );
      await res.refetch();
    } catch (error) {
      form.set(failedDraft(form(), errorMessage(error)));
    }
  };

  const failure = form().status;

  return (
    <SettingsSection>
      <h3 class="m-0 text-lg font-semibold">Limits</h3>
      <p class="m-0 text-sm opacity-70">
        Requests per minute the edge lets through to this app, across all its
        hostnames. Past a limit, visitors get <code>429 Too Many Requests</code>{" "}
        with a <code>Retry-After</code> header. Leave a field empty for the
        platform default, or enter <code>0</code> for no limit. Fleet memory
        caps this app's own cgroup in MiB; leave it empty for the platform
        default. Sleep after parks this app after that many idle seconds (
        <code>0</code> = never); leave it empty for the install default.
      </p>
      {failure._tag === "Failed" ? (
        <p class="text-error m-0 text-sm">{failure.error}</p>
      ) : null}
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
            value={draft.clientRpm}
            placeholder={
              current.perClient
                ? defaultLabel(current.defaults.clientRpm)
                : "Off on this install"
            }
            disabled={!isAdmin || busy || !current.perClient}
            oninput={(e) => {
              edit({ clientRpm: e.currentTarget.value });
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
            value={draft.appRpm}
            placeholder={defaultLabel(current.defaults.appRpm)}
            disabled={!isAdmin || busy}
            oninput={(e) => {
              edit({ appRpm: e.currentTarget.value });
            }}
          />
        </fieldset>
        <fieldset class="fieldset min-w-40 flex-1">
          <label class="label" for="limit-memory">
            Fleet memory (MiB)
          </label>
          <input
            id="limit-memory"
            class="input input-sm"
            type="number"
            min="64"
            max={current.defaults.memoryMaxMb ?? undefined}
            step="1"
            value={draft.memoryMb}
            placeholder={
              current.defaults.memoryMaxMb === null
                ? `Default: ${current.defaults.memoryMb} MiB`
                : `Default: ${current.defaults.memoryMb} MiB (max ${current.defaults.memoryMaxMb})`
            }
            disabled={!isAdmin || busy}
            oninput={(e) => {
              edit({ memoryMb: e.currentTarget.value });
            }}
          />
        </fieldset>
        <fieldset class="fieldset min-w-40 flex-1">
          <label class="label" for="limit-sleep">
            Sleep after (s)
          </label>
          <input
            id="limit-sleep"
            class="input input-sm"
            type="number"
            min="0"
            step="1"
            value={draft.sleepAfterS}
            placeholder={sleepPlaceholder(current.defaults.defaultSleepAfterS)}
            disabled={!isAdmin || busy}
            oninput={(e) => {
              edit({ sleepAfterS: e.currentTarget.value });
            }}
          />
        </fieldset>
        {isAdmin ? (
          <button
            type="submit"
            class="btn btn-sm"
            disabled={busy || !formCanSave(form())}
          >
            {busy ? "Saving…" : "Save limits"}
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
          Only an app admin can change limits. A new memory cap applies when the
          fleet next spawns.
        </p>
      )}
      {failure._tag === "Saved" ? (
        <p class="m-0 text-sm opacity-70">
          Saved. Rate limits apply within seconds; memory applies when the fleet
          next spawns.
        </p>
      ) : null}
    </SettingsSection>
  );
};
