//! Shared furniture for the admin tabs: the card shell every tab is, its
//! search control, its skeleton/problem rows, the row layout, and the native
//! confirm gate for destructive actions. Each tab file holds only its rows.

import { atom } from "ilha";
import type { View } from "ilha";

import { errorMessage } from "../errors";

/** The three tabs share one layout so switching between them moves nothing:
 * the same card (header, note, rows), the same control sizes, and the same
 * action column. Anything a tab adds goes into a slot of it, never around it. */

/** Header inputs and buttons. `btn` (solid) is the tab's one primary action;
 * every row action and the pager is `ACTION`. */
const FIELD = "input input-sm w-56";
const PRIMARY = "btn btn-sm";
export const ACTION = "btn btn-sm btn-ghost";
export const DANGER = `${ACTION} text-error`;
/** Row actions are right-aligned and fixed-width, so a label that flips
 * (Stop/Start, Ban/Unban, Make/Remove admin) or a button that is absent
 * (Revoke on a used code) never shifts its neighbours. */
export const W_SM = "min-w-20";
export const W_LG = "min-w-28";
const ACTIONS = "flex flex-wrap items-center justify-end gap-1";
const NOTE_ROW = "px-4 pb-2 text-xs opacity-70";
const ERROR_ROW = "text-error px-4 pb-2 text-sm";
export const EMPTY_ROW = "px-4 pt-2 pb-4 text-sm opacity-70";
const SKELETON_ROWS = 3;

/** Each tab is one daisyUI list, and the list *is* the card (the same shape as
 * the apps list): a `list-row` carries `padding: 1rem` itself, so putting one
 * inside a `card-body` padded the rows twice and shifted them off the header.
 * The header and note are plain `li`s (no `list-row`, so no divider), and the
 * header has a fixed height so a tab with no controls does not sit shorter. */
export const PanelCard = ({
  children,
  controls,
  note,
  title,
}: {
  children: View;
  controls?: View;
  note: string;
  title: string;
}) => (
  <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
    <li class="flex min-h-14 flex-wrap items-center justify-between gap-2 p-4 pb-2">
      <span class="text-lg font-semibold tracking-wide">{title}</span>
      <span class="flex items-center gap-2">{controls}</span>
    </li>
    <li class={NOTE_ROW}>{note}</li>
    {children}
  </ul>
);

/** Rows while a list loads: the real row shape, so the card keeps its height
 * and the header and controls above stay put. */
export const SkeletonRows = () => (
  <>
    {Array.from({ length: SKELETON_ROWS }, (_, i) => (
      <li key={i} class="list-row items-center">
        <div>
          <div class="skeleton size-10 shrink-0 rounded-full" />
        </div>
        <div class="list-col-grow flex flex-col gap-1">
          <div class="skeleton h-4 w-40" />
          <div class="skeleton h-3 w-24" />
        </div>
        <div class={ACTIONS} />
      </li>
    ))}
  </>
);

/** Load and mutation failures, as rows inside the card (a paragraph above it
 * would push the card down). */
export const Problems = ({ load, panel }: { load: unknown; panel: string }) => (
  <>
    {load ? (
      <li class={ERROR_ROW}>Failed to load: {errorMessage(load)}</li>
    ) : null}
    {panel ? <li class={ERROR_ROW}>{panel}</li> : null}
  </>
);

/** The header's search, identical on every tab: an input and a Search button,
 * applied on submit (never per keystroke) and kept in the URL by the caller, so
 * a refresh, a shared link or a trip through another tab restores it. Submitting
 * an empty box clears the search. */
export const SearchForm = ({
  id,
  label,
  onSearch,
  placeholder,
  value,
}: {
  id: string;
  label: string;
  onSearch: (value: string) => void;
  placeholder: string;
  value: string;
}) => {
  const draft = atom(value);
  return (
    <form
      class="flex items-center gap-2"
      role="search"
      onsubmit={(event: SubmitEvent) => {
        event.preventDefault();
        onSearch(draft().trim());
      }}
    >
      <input
        id={id}
        class={FIELD}
        type="search"
        placeholder={placeholder}
        aria-label={label}
        value={draft()}
        oninput={(e) => {
          draft.set(e.currentTarget.value);
        }}
      />
      <button type="submit" class={PRIMARY}>
        Search
      </button>
    </form>
  );
};

/** One row: avatar, a growing text column, and the actions. */
export const AdminRow = ({
  actions,
  avatar,
  children,
}: {
  actions?: View;
  avatar: View;
  children: View;
}) => (
  <li class="list-row items-center">
    <div>{avatar}</div>
    <div class="list-col-grow min-w-0">{children}</div>
    <div class={ACTIONS}>{actions}</div>
  </li>
);

/** Native confirm dialog: the requirement for privilege changes and
 * destructive deletes. */
export const confirmAction = (message: string): boolean =>
  // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive admin actions.
  window.confirm(message);

/** Parse `?up=` (page index): garbage falls back to the first page. */
export const toPageIndex = (raw: string): number =>
  Math.max(Math.trunc(Number(raw)) || 0, 0);
