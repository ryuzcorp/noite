//! The right-side row editor: raw-text fields (never typed inputs — see
//! ../d1-values), NULL toggles, Now/Format helpers, foreign-key jumps,
//! dirty tracking and an inline discard guard. Mounted per open row, so its
//! draft state starts fresh every time.

import { atom } from "ilha";
import type { View } from "ilha";

import { formatAgo, formatDateTime } from "../../dates";
import { errorMessage } from "../../errors";
import { collectRef, liveEl, newLiveRef } from "../../live-ref";
import type {
  D1Cell,
  D1Column,
  D1ForeignKey,
  D1TableSchema,
  D1WriteBody,
} from "../../runner";
import { d1Write } from "../../server/storage.server";
import { Dialog } from "../../ui/dialog";
import { X } from "../../ui/icons";
import {
  cellFromDraft,
  draftDiffers,
  draftFromCell,
  formatJson,
  isBlobText,
  isBoolType,
  isTimestampColumn,
  jsonValid,
  keyFor,
  nowValue,
  parseTimestamp,
  prefersTextarea,
  timestampKind,
  writeValues,
} from "../d1-values";
import type { FieldDraft, FieldDrafts } from "../d1-values";

/** A guard pending the user's discard decision. */
type Pending =
  | { kind: "close" }
  | { column: string; kind: "fk"; table: string; value: D1Cell };

/** Fresh drafts for one open row. INSERT starts every field empty and
 * untouched (omitted from the write, so the DDL default applies); a NULL
 * toggle is an explicit, touched choice. */
const initialDrafts = (
  columns: readonly D1Column[],
  row: Record<string, D1Cell> | null
): FieldDrafts => {
  const drafts: FieldDrafts = {};
  for (const column of columns) {
    drafts[column.name] = draftFromCell(
      row === null ? "" : (row[column.name] ?? null)
    );
  }
  return drafts;
};

/** A field control the user can actually type into (the focus target when the
 * row editor opens). */
const FIELD_SELECTOR =
  'input[id^="d1-field-"]:not(:disabled), textarea[id^="d1-field-"]:not(:disabled)';

/** The primary-key badge: position only when the key is composite. */
const pkBadgeFor = (column: D1Column, pkCount: number): string | null => {
  if (column.pk === 0) {
    return null;
  }
  return pkCount > 1 ? `PK ${column.pk}` : "PK";
};

/** The editor title line: insert, editable update, or read-only view. */
const editorTitle = (isEdit: boolean, canUpdate: boolean): string => {
  if (!isEdit) {
    return "Insert row";
  }
  return canUpdate ? "Update row" : "View row";
};

/** Footer delete: one click opens an inline confirm that names the row. */
const DeleteControl = ({
  busy,
  confirming,
  keyLabel,
  onCancel,
  onDelete,
  onRequest,
}: {
  busy: boolean;
  confirming: boolean;
  keyLabel: string;
  onCancel: () => void;
  onDelete: () => void;
  onRequest: () => void;
}) => {
  if (!confirming) {
    return (
      <button
        type="button"
        class="btn btn-sm btn-ghost text-error"
        onclick={onRequest}
      >
        Delete row
      </button>
    );
  }
  return (
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="text-error">Delete row where {keyLabel}?</span>
      <button
        type="button"
        class="btn btn-sm btn-error"
        disabled={busy}
        onclick={onDelete}
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        disabled={busy}
        onclick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
};

/** The note shown beside a field the editor refuses to write. The primary key
 * needs no note: its `PK` badge says it, and the input is disabled. */
const noteFor = (
  column: D1Column,
  schema: D1TableSchema,
  cell: D1Cell
): string | null => {
  if (schema.redacted.includes(column.name)) {
    return "redacted";
  }
  const note = schema.locked[column.name];
  if (note !== undefined) {
    return note;
  }
  if (cell !== null && isBlobText(cell)) {
    return "binary";
  }
  return null;
};

const Badge = ({ children }: { children: View }) => (
  <span class="badge badge-sm font-normal opacity-70">{children}</span>
);

/** The field's name and its badges (type, PK, NOT NULL, default, FK, note)
 * plus the NULL toggle for a nullable, editable column. */
const FieldLegend = ({
  column,
  disabled,
  draft,
  fk,
  inputId,
  note,
  onToggleNull,
  pkBadge,
}: {
  column: D1Column;
  disabled: boolean;
  draft: FieldDraft;
  fk: D1ForeignKey | undefined;
  inputId: string;
  note: string | null;
  onToggleNull: (isNull: boolean) => void;
  /** `PK` for a single-column key, `PK n` when the key is composite. */
  pkBadge: string | null;
}) => (
  <legend class="label flex w-full flex-wrap items-center gap-1 py-0">
    <label class="font-medium" for={inputId}>
      {column.name}
    </label>
    {column.type === "" ? null : <Badge>{column.type}</Badge>}
    {pkBadge === null ? null : <Badge>{pkBadge}</Badge>}
    {column.notNull ? <Badge>NOT NULL</Badge> : null}
    {column.defaultValue === null ? null : (
      <Badge>{`default ${column.defaultValue}`}</Badge>
    )}
    {fk === undefined ? null : <Badge>{`FK → ${fk.table}.${fk.to}`}</Badge>}
    {note === null ? null : <Badge>{note}</Badge>}
    {column.notNull || disabled ? null : (
      <label class="label ml-auto cursor-pointer gap-1 py-0 text-xs opacity-70">
        <input
          class="checkbox checkbox-sm"
          type="checkbox"
          checked={draft.isNull}
          onchange={(event) => {
            onToggleNull(event.currentTarget.checked);
          }}
        />
        NULL
      </label>
    )}
  </legend>
);

/** The editor control for one field: a 0/1 toggle for booleans, an
 * auto-growing textarea for long/multiline/JSON values, else a raw text
 * input. Never a typed `date`/`number` input: those sanitize a value the
 * browser rejects (an ISO stamp with Z + milliseconds, an epoch int, a
 * non-numeric string in a numeric column) to "" and the field would render
 * empty while the row holds a value. */
const FieldValue = ({
  column,
  disabled,
  draft,
  inputId,
  onChange,
}: {
  column: D1Column;
  disabled: boolean;
  draft: FieldDraft;
  inputId: string;
  onChange: (patch: Partial<FieldDraft>) => void;
}) => {
  const value = draft.text;
  const fieldDisabled = disabled || draft.isNull;
  const setText = (text: string) => {
    onChange({ text, touched: true });
  };
  if (isBoolType(column.type) && !disabled) {
    return (
      <div class="join w-full">
        {(["0", "1"] as const).map((digit) => (
          <button
            key={digit}
            type="button"
            class={`btn btn-sm join-item flex-1 ${!draft.isNull && value === digit ? "btn-active" : ""}`}
            aria-pressed={!draft.isNull && value === digit ? "true" : "false"}
            onclick={() => {
              onChange({ isNull: false, text: digit, touched: true });
            }}
          >
            {digit}
          </button>
        ))}
      </div>
    );
  }
  if (!draft.isNull && prefersTextarea(value)) {
    return (
      <textarea
        id={inputId}
        class="textarea textarea-sm w-full font-mono text-xs disabled:opacity-60"
        rows={String(Math.min(Math.max(value.split("\n").length, 2), 12))}
        disabled={fieldDisabled}
        value={value}
        oninput={(event) => {
          setText(event.currentTarget.value);
        }}
      />
    );
  }
  return (
    <input
      id={inputId}
      class="input input-sm w-full font-mono text-xs disabled:opacity-60"
      type="text"
      disabled={fieldDisabled}
      placeholder={draft.isNull ? "NULL" : undefined}
      value={value}
      oninput={(event) => {
        setText(event.currentTarget.value);
      }}
    />
  );
};

/** The per-column helpers that never reformat an untouched value: Now (in
 * the field's existing format), JSON pretty-print/validation, the foreign-key
 * jump, and the local-time hint. A NULL field needs no hint here: the checked
 * NULL toggle plus the disabled input's `NULL` placeholder say it. */
const FieldHelpers = ({
  column,
  disabled,
  draft,
  fk,
  onChange,
  onOpenFk,
  original,
}: {
  column: D1Column;
  disabled: boolean;
  draft: FieldDraft;
  fk: D1ForeignKey | undefined;
  onChange: (patch: Partial<FieldDraft>) => void;
  onOpenFk: (() => void) | null;
  original: D1Cell;
}) => {
  const value = draft.text;
  const date = draft.isNull ? null : parseTimestamp(value);
  const json = draft.isNull || disabled ? null : jsonValid(value);
  const showNow = !disabled && isTimestampColumn(column.name, column.type);
  return (
    <div class="flex flex-wrap items-center gap-2 pt-1 text-xs">
      {showNow ? (
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          title="Set to now, in this field's existing format"
          onclick={() => {
            onChange({
              isNull: false,
              text: nowValue(timestampKind(original)),
              touched: true,
            });
          }}
        >
          Now
        </button>
      ) : null}
      {json === null ? null : (
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onclick={() => {
            const pretty = formatJson(value);
            if (pretty !== null) {
              onChange({ text: pretty, touched: true });
            }
          }}
        >
          Format JSON
        </button>
      )}
      {json === false ? <span class="text-error">invalid JSON</span> : null}
      {onOpenFk === null ? null : (
        <button type="button" class="btn btn-sm btn-ghost" onclick={onOpenFk}>
          {`Open → ${fk?.table ?? ""}`}
        </button>
      )}
      {date === null ? null : (
        <span class="opacity-60">
          {formatDateTime(date)} · {formatAgo(date)}
        </span>
      )}
    </div>
  );
};

/** One editable field: legend, control and helpers. */
const FieldRow = ({
  column,
  dirty,
  disabled,
  draft,
  fk,
  inputId,
  note,
  onChange,
  onOpenFk,
  onToggleNull,
  original,
  pkBadge,
}: {
  column: D1Column;
  dirty: boolean;
  disabled: boolean;
  draft: FieldDraft;
  fk: D1ForeignKey | undefined;
  inputId: string;
  note: string | null;
  onChange: (patch: Partial<FieldDraft>) => void;
  onOpenFk: (() => void) | null;
  onToggleNull: (isNull: boolean) => void;
  /** The stored cell, so `Now` keeps the field's existing format. */
  original: D1Cell;
  pkBadge: string | null;
}) => (
  <fieldset
    class={`fieldset w-full ${dirty ? "border-base-content/30 bg-base-200/60 rounded-box border-l-4 py-2 pr-2 pl-3" : "py-2"}`}
  >
    <FieldLegend
      column={column}
      disabled={disabled}
      draft={draft}
      fk={fk}
      inputId={inputId}
      note={note}
      onToggleNull={onToggleNull}
      pkBadge={pkBadge}
    />
    <FieldValue
      column={column}
      disabled={disabled}
      draft={draft}
      inputId={inputId}
      onChange={onChange}
    />
    <FieldHelpers
      column={column}
      disabled={disabled}
      draft={draft}
      fk={fk}
      onChange={onChange}
      onOpenFk={onOpenFk}
      original={original}
    />
  </fieldset>
);

export const RowEditor = ({
  appId,
  databaseId,
  onClose,
  onOpenFk,
  onSaved,
  onToast,
  row,
  schema,
}: {
  appId: string;
  databaseId: string;
  onClose: () => void;
  onOpenFk: (target: { column: string; table: string; value: D1Cell }) => void;
  onSaved: () => void;
  onToast: (text: string) => void;
  /** The row being edited; null opens an INSERT. */
  row: Record<string, D1Cell> | null;
  schema: D1TableSchema;
}) => {
  const isEdit = row !== null;
  const original = row ?? {};
  const open = atom(true);
  const busy = atom(false);
  const confirmingDelete = atom(false);
  const failure = atom("");
  const pending = atom<Pending | null>(null);
  const drafts = atom<FieldDrafts>(initialDrafts(schema.columns, row));
  const box = atom.lazy(newLiveRef<HTMLDivElement>)();
  const focused = atom.lazy(() => ({ done: false }))();

  /** `showModal()` focuses the first focusable element — the × close button.
   * Put focus on the first editable field instead, or on the panel title when
   * every field is read-only. Runs until it finds the connected element (the
   * ref also fires for ilha's detached scratch copies) and only once. */
  const focusInitial = () => {
    let frames = 0;
    const attempt = () => {
      frames += 1;
      const root = liveEl(box);
      const target =
        root?.querySelector<HTMLElement>(FIELD_SELECTOR) ??
        root?.querySelector<HTMLElement>("h3");
      if (target) {
        focused.done = true;
        target.focus();
        return;
      }
      if (frames < 10) {
        requestAnimationFrame(attempt);
      }
    };
    requestAnimationFrame(attempt);
  };

  const lockedColumns = [...Object.keys(schema.locked), ...schema.redacted];
  const scope = {
    columns: schema.columns,
    drafts: drafts(),
    isEdit,
    locked: lockedColumns,
    original,
  };
  const values = writeValues(scope);
  const changeCount = Object.keys(values).length;
  const dirty = changeCount > 0;
  const canUpdate = schema.caps.update || !isEdit;
  const pkCount = schema.columns.filter((column) => column.pk > 0).length;

  const patch = (name: string, next: Partial<FieldDraft>) => {
    const current = drafts();
    const existing = current[name] ?? draftFromCell(original[name] ?? null);
    drafts.set({ ...current, [name]: { ...existing, ...next } });
  };

  const save = async () => {
    if (busy() || !dirty || !canUpdate) {
      return;
    }
    busy.set(true);
    try {
      // An INSERT omits `key` entirely: the action transport encodes args as
      // JSON, where an explicit `undefined` is not a JSON value.
      const body: D1WriteBody = {
        op: isEdit ? "update" : "insert",
        table: schema.table,
        values,
      };
      if (isEdit) {
        body.key = keyFor(schema.columns, original);
      }
      await d1Write({ appId, databaseId, ...body });
      onToast(isEdit ? "Row updated" : "Row created");
      onSaved();
      onClose();
    } catch (error) {
      failure.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  const remove = async () => {
    if (busy()) {
      return;
    }
    busy.set(true);
    try {
      await d1Write({
        appId,
        databaseId,
        key: keyFor(schema.columns, original),
        op: "delete",
        table: schema.table,
        values: {},
      });
      onToast("Row deleted");
      onSaved();
      onClose();
    } catch (error) {
      failure.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  const requestClose = () => {
    if (dirty) {
      pending.set({ kind: "close" });
      open.set(true);
      return;
    }
    onClose();
  };

  const openFk = (column: D1Column) => {
    const fk = schema.foreignKeys.find((key) => key.from === column.name);
    if (fk === undefined) {
      return;
    }
    const draft = drafts()[column.name] ?? draftFromCell(null);
    const target: Pending = {
      column: fk.to,
      kind: "fk",
      table: fk.table,
      value: cellFromDraft(draft),
    };
    if (dirty) {
      pending.set(target);
      open.set(true);
      return;
    }
    onOpenFk(target);
  };

  const keyLabel = (): string => {
    const key = keyFor(schema.columns, original);
    return Object.entries(key)
      .map(([name, value]) => `${name} = ${value === null ? "NULL" : value}`)
      .join(", ");
  };

  const changeLabel = (): string => {
    if (dirty) {
      return `${changeCount} change${changeCount === 1 ? "" : "s"}`;
    }
    if (isEdit) {
      return "No changes";
    }
    return "Untouched fields use their DDL default";
  };

  const titleId = `d1-editor-title-${schema.table}`;
  const activePending = pending();
  const title = editorTitle(isEdit, canUpdate);
  return (
    <Dialog
      open={open}
      class="modal modal-end"
      labelledBy={titleId}
      onClose={requestClose}
    >
      <div
        class="modal-box bg-base-100 dark:bg-base-200 flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden p-0"
        ref={(el) => {
          collectRef(box, el);
          if (el && !focused.done) {
            focusInitial();
          }
        }}
        onkeydown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      >
        <header class="border-base-300 flex items-center gap-2 border-b px-4 py-3">
          <h3
            id={titleId}
            tabindex="-1"
            class="m-0 text-lg font-bold outline-none"
          >
            {title}
            <span class="font-normal opacity-60"> · {schema.table}</span>
          </h3>
          <button
            type="button"
            class="btn btn-square btn-ghost btn-sm ml-auto"
            aria-label="Close editor"
            onclick={requestClose}
          >
            <X />
          </button>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          {activePending === null ? null : (
            <div class="alert alert-warning alert-soft flex-wrap text-sm">
              <span>
                {activePending.kind === "close"
                  ? `You have ${changeCount} unsaved change${changeCount === 1 ? "" : "s"}.`
                  : "This field links elsewhere — leave without saving?"}
              </span>
              <button
                type="button"
                class="btn btn-sm btn-neutral"
                onclick={() => {
                  pending.set(null);
                  if (activePending.kind === "close") {
                    onClose();
                    return;
                  }
                  onOpenFk(activePending);
                }}
              >
                Discard
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick={() => {
                  pending.set(null);
                }}
              >
                Keep editing
              </button>
            </div>
          )}
          {failure() === "" ? null : (
            <p class="text-error m-0 text-sm">{failure()}</p>
          )}
          {schema.columns.map((column) => {
            const draft =
              drafts()[column.name] ??
              draftFromCell(original[column.name] ?? null);
            const fk = schema.foreignKeys.find(
              (key) => key.from === column.name
            );
            const note = noteFor(column, schema, original[column.name] ?? null);
            return (
              <FieldRow
                key={column.name}
                column={column}
                dirty={
                  isEdit
                    ? draftDiffers(draft, original[column.name] ?? null)
                    : draft.touched
                }
                disabled={
                  !canUpdate || note !== null || (isEdit && column.pk > 0)
                }
                draft={draft}
                fk={fk}
                inputId={`d1-field-${schema.table}-${column.name}`}
                note={note}
                onChange={(next) => {
                  patch(column.name, next);
                }}
                onOpenFk={
                  fk === undefined
                    ? null
                    : () => {
                        openFk(column);
                      }
                }
                onToggleNull={(isNull) => {
                  patch(column.name, { isNull, touched: true });
                }}
                original={original[column.name] ?? null}
                pkBadge={pkBadgeFor(column, pkCount)}
              />
            );
          })}
        </div>
        <footer class="border-base-300 flex flex-wrap items-center gap-2 border-t px-4 py-3">
          {isEdit && schema.caps.delete ? (
            <DeleteControl
              busy={busy()}
              confirming={confirmingDelete()}
              keyLabel={keyLabel()}
              onCancel={() => {
                confirmingDelete.set(false);
              }}
              onDelete={() => {
                void remove();
              }}
              onRequest={() => {
                confirmingDelete.set(true);
              }}
            />
          ) : null}
          <span class="ml-auto text-xs opacity-60">{changeLabel()}</span>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={busy()}
            onclick={requestClose}
          >
            {canUpdate ? "Cancel" : "Close"}
          </button>
          {canUpdate ? (
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={busy() || !dirty}
              onclick={() => {
                void save();
              }}
            >
              {busy() ? "Saving…" : "Save"}
            </button>
          ) : null}
        </footer>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button aria-label="Close dialog">close</button>
      </form>
    </Dialog>
  );
};
