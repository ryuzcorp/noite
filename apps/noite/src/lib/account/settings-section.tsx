//! The one renderer for an admin on/off setting card (telemetry, release
//! check). It reads the shared state machine (`settings.machine.ts`) and
//! emits events; the card around it owns its own API call and extra rows.
//!
//! The locked notice always names the *stored* preference, so an operator can
//! tell "stored on, ignored" from "stored off" — the two cards used to hide
//! it behind the effective value.
import type { View } from "ilha";

import { LoadError } from "../ui/load-error";
import { SectionSkeleton } from "../ui/skeletons";
import type { SettingsState } from "./settings.machine";

export interface SettingsSectionProps {
  /** Shown while a background check is in flight (release check only). */
  readonly check?: View;
  /** The explanation under the checkbox. */
  readonly description: View;
  /** Rows only this card has (last-checked, payload preview, …). */
  readonly extra?: View;
  readonly id: string;
  readonly label: string;
  /** Persist `value`; the caller dispatches SaveStarted/SaveSucceeded/
   * SaveFailed on its machine around its request. */
  readonly onSave: (value: boolean) => void;
  /** The confirmation line, per card (the e2e specs assert it verbatim). */
  readonly savedMessage: string;
  /** The machine's current model (see `syncStatus`). */
  readonly state: SettingsState;
  readonly title: string;
  readonly onToggle: (value: boolean) => void;
}

export const SettingsSection = ({
  check,
  description,
  extra,
  id,
  label,
  onSave,
  onToggle,
  savedMessage,
  state,
  title,
}: SettingsSectionProps) => {
  const heading = <h2 class="m-0 text-lg font-semibold">{title}</h2>;

  if (state._tag === "Loading") {
    return <SectionSkeleton lines={3} />;
  }

  if (state._tag === "Failed") {
    return (
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        {heading}
        <LoadError error={state.message} label="Failed to load this setting" />
      </section>
    );
  }

  if (state._tag === "Locked") {
    return (
      <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
        {heading}
        <div class="flex flex-col gap-1">
          <p class="m-0 text-sm font-medium">{label}</p>
          <label class="flex cursor-default items-center gap-2 text-sm">
            <input
              id={id}
              type="checkbox"
              class="checkbox checkbox-sm"
              checked={state.stored}
              disabled
            />
            {label}
          </label>
          <p class="m-0 text-sm opacity-70">
            Disabled by {state.reason ?? "the operator"} — stored preference is{" "}
            <strong>{state.stored ? "on" : "off"}</strong> and is ignored while
            the lock is in place.
          </p>
        </div>
        {description}
      </section>
    );
  }

  const saving = state.save === "saving";

  return (
    <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
      {heading}
      <div class="flex flex-col gap-1">
        <p class="m-0 text-sm font-medium">{label}</p>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            class="checkbox checkbox-sm"
            checked={state.draft}
            disabled={saving}
            onchange={(event) => {
              onToggle(event.currentTarget.checked);
            }}
          />
          {label}
        </label>
        {state.draft === state.stored ? null : (
          <p class="m-0 text-xs opacity-70">Unsaved change.</p>
        )}
      </div>
      {description}
      {extra}
      {state.error ? <p class="text-error m-0 text-sm">{state.error}</p> : null}
      {state.save === "saved" ? (
        <p class="text-success m-0 text-sm">{savedMessage}</p>
      ) : null}
      {state.check === "running" ? check : null}
      <div>
        <button
          type="button"
          class="btn btn-sm btn-neutral"
          disabled={saving}
          onclick={() => {
            onSave(state.draft);
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
};
