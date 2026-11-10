//! The right-side row editor: raw-text fields (never typed inputs — see
//! ../d1-values), NULL toggles, Now/Format helpers, foreign-key jumps,
//! dirty tracking and an inline discard guard. Mounted per open row, so its
//! draft state starts fresh every time.

import { atom } from "ilha";
import type { View } from "ilha";

import { api } from "../../api";
import { formatAgo, formatDateTime } from "../../dates";
import { errorMessage } from "../../errors";
import { collectRef, liveEl, newLiveRef } from "../../live-ref";
import type {
  D1Cell,
  D1Column,
  D1ForeignKey,
  D1Key,
  D1TableSchema,
  D1WriteBody,
} from "../../runner";
import { Dialog } from "../../ui/dialog";
import { X } from "../../ui/icons";
import {
  cellFromDraft,
  draftFromCell,
  draftIsNull,
  draftText,
  fieldDirty,
  formatJson,
  isBlobText,
  isBoolType,
  isTimestampColumn,
  jsonValid,
  markedNull,
  nowValue,
  parseTimestamp,
  prefersTextarea,
  timestampKind,
  typedText,
} from "../d1-values";
import type { FieldDraft, FieldDrafts } from "../d1-values";
import {
  changesOf,
  draftsOf,
  keyLabel,
  nextEditor,
  Phase,
} from "./editor-machine";
import type {
  EditorContext,
  EditorEvent,
  EditorPhase,
  PendingAction,
} from "./editor-machine";

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
  onCancel,
  onDelete,
  onRequest,
  rowLabel,
}: {
  busy: boolean;
  confirming: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onRequest: () => void;
  rowLabel: string;
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
      <span class="text-error">Delete row where {rowLabel}?</span>
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
          checked={draftIsNull(draft)}
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
  onChange: (draft: FieldDraft) => void;
}) => {
  const value = draftText(draft);
  const fieldDisabled = disabled || draftIsNull(draft);

  const setText = (text: string) => {
    onChange(typedText(text));
  };

  if (isBoolType(column.type) && !disabled) {
    return (
      <div class="join w-full">
        {(["0", "1"] as const).map((digit) => (
          <button
            key={digit}
            type="button"
            class={`btn btn-sm join-item flex-1 ${!draftIsNull(draft) && value === digit ? "btn-active" : ""}`}
            aria-pressed={
              !draftIsNull(draft) && value === digit ? "true" : "false"
            }
            onclick={() => {
              onChange(typedText(digit));
            }}
          >
            {digit}
          </button>
        ))}
      </div>
    );
  }

  if (!draftIsNull(draft) && prefersTextarea(value)) {
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
      placeholder={draftIsNull(draft) ? "NULL" : undefined}
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
  onChange: (draft: FieldDraft) => void;
  onOpenFk: (() => void) | null;
  original: D1Cell;
}) => {
  const value = draftText(draft);
  const date = draftIsNull(draft) ? null : parseTimestamp(value);
  const json = draftIsNull(draft) || disabled ? null : jsonValid(value);
  const showNow = !disabled && isTimestampColumn(column.name, column.type);

  return (
    <div class="flex flex-wrap items-center gap-2 pt-1 text-xs">
      {showNow ? (
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          title="Set to now, in this field's existing format"
          onclick={() => {
            onChange(typedText(nowValue(timestampKind(original))));
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
              onChange(typedText(pretty));
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
  onChange: (draft: FieldDraft) => void;
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

  const phase = atom<EditorPhase>(
    Phase.Editing({ drafts: initialDrafts(schema.columns, row) })
  );

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

  const context: EditorContext = {
    columns: schema.columns,
    isEdit,
    locked: [...Object.keys(schema.locked), ...schema.redacted],
    original,
    schema,
  };

  const canUpdate = schema.caps.update || !isEdit;
  const pkCount = schema.columns.filter((column) => column.pk > 0).length;
  const drafts = draftsOf(phase()) ?? {};
  const changeCount = changesOf(phase(), context).length;

  /** Record a completion event (no effect: `saved`/`deleted`/`failed` only
   * move the state) and close when the machine says so. */
  const settle = (event: EditorEvent) => {
    const step = nextEditor(phase(), event, context);
    phase.set(step.state);

    if (step.state._tag === "Closed") {
      onClose();
    }
  };

  const saveRow = async (body: D1WriteBody) => {
    try {
      await api<{ ok: true }>("/api/storage/d1Write", {
        appId,
        databaseId,
        ...body,
      });
      onToast(isEdit ? "Row updated" : "Row created");
      onSaved();
      settle({ kind: "saved" });
    } catch (error) {
      settle({ kind: "failed", message: errorMessage(error) });
    }
  };

  const deleteRow = async (key: D1Key) => {
    try {
      await api<{ ok: true }>("/api/storage/d1Write", {
        appId,
        databaseId,
        key,
        op: "delete",
        table: schema.table,
        values: {},
      });
      onToast("Row deleted");
      onSaved();
      settle({ kind: "deleted" });
    } catch (error) {
      settle({ kind: "failed", message: errorMessage(error) });
    }
  };

  /** The one dispatcher: every state change goes through the machine, and the
   * effect it returns is the only side effect performed. */
  const apply = (event: EditorEvent) => {
    const step = nextEditor(phase(), event, context);
    phase.set(step.state);

    if (step.state._tag === "Guarded") {
      // Esc/backdrop closed the native dialog; the guard is a state, so the
      // dialog re-opens on it rather than the prompt being lost.
      open.set(true);
    }

    switch (step.effect.kind) {
      case "navigate": {
        onOpenFk({
          column: step.effect.target.column,
          table: step.effect.target.table,
          value: step.effect.target.value,
        });

        break;
      }

      case "save": {
        void saveRow(step.effect.body);

        break;
      }

      case "delete": {
        void deleteRow(step.effect.key);

        break;
      }

      default: {
        break;
      }
    }

    if (step.state._tag === "Closed") {
      onClose();
    }
  };

  const openFk = (column: D1Column) => {
    const fk = schema.foreignKeys.find((key) => key.from === column.name);

    if (fk === undefined) {
      return;
    }

    const draft = drafts[column.name] ?? draftFromCell(null);

    const target: PendingAction & { kind: "fk" } = {
      column: fk.to,
      kind: "fk",
      table: fk.table,
      value: cellFromDraft(draft),
    };

    apply({ kind: "fkRequest", target });
  };

  const changeLabel = (): string => {
    if (changeCount > 0) {
      return `${changeCount} change${changeCount === 1 ? "" : "s"}`;
    }

    return isEdit ? "No changes" : "Untouched fields use their DDL default";
  };

  const titleId = `d1-editor-title-${schema.table}`;
  const title = editorTitle(isEdit, canUpdate);
  const current = phase();

  if (current._tag === "Closed") {
    return null;
  }

  const armed = current._tag === "DeleteConfirm" || current._tag === "Deleting";
  const action = current._tag === "Guarded" ? current.action : null;
  const failure = current._tag === "Failed" ? current.message : "";

  return (
    <Dialog
      open={open}
      class="modal modal-end"
      labelledBy={titleId}
      onClose={() => {
        apply({ kind: "closeRequest" });
      }}
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
            apply({ kind: "save" });
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
            onclick={() => {
              apply({ kind: "closeRequest" });
            }}
          >
            <X />
          </button>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          {action === null ? null : (
            <div class="alert alert-warning alert-soft flex-wrap text-sm">
              <span>
                {action.kind === "close"
                  ? `You have ${changeCount} unsaved change${changeCount === 1 ? "" : "s"}.`
                  : "This field links elsewhere — leave without saving?"}
              </span>
              <button
                type="button"
                class="btn btn-sm btn-neutral"
                onclick={() => {
                  apply({ kind: "guardDiscard" });
                }}
              >
                Discard
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick={() => {
                  apply({ kind: "guardCancel" });
                }}
              >
                Keep editing
              </button>
            </div>
          )}
          {failure === "" ? null : (
            <p class="text-error m-0 text-sm" role="alert">
              {failure}
            </p>
          )}
          {schema.columns.map((column) => {
            const draft =
              drafts[column.name] ??
              draftFromCell(original[column.name] ?? null);

            const fk = schema.foreignKeys.find(
              (key) => key.from === column.name
            );

            const note = noteFor(column, schema, original[column.name] ?? null);

            return (
              <FieldRow
                key={column.name}
                column={column}
                dirty={fieldDirty(draft, original[column.name] ?? null, isEdit)}
                disabled={
                  !canUpdate || note !== null || (isEdit && column.pk > 0)
                }
                draft={draft}
                fk={fk}
                inputId={`d1-field-${schema.table}-${column.name}`}
                note={note}
                onChange={(next) => {
                  apply({ draft: next, kind: "patch", name: column.name });
                }}
                onOpenFk={
                  fk === undefined
                    ? null
                    : () => {
                        openFk(column);
                      }
                }
                onToggleNull={(isNull) => {
                  apply({
                    draft: isNull ? markedNull() : typedText(""),
                    kind: "patch",
                    name: column.name,
                  });
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
              busy={current._tag === "Deleting"}
              confirming={armed}
              rowLabel={keyLabel(schema.columns, original)}
              onCancel={() => {
                apply({ kind: "deleteCancel" });
              }}
              onDelete={() => {
                apply({ kind: "deleteConfirm" });
              }}
              onRequest={() => {
                apply({ kind: "deleteRequest" });
              }}
            />
          ) : null}
          <span class="ml-auto text-xs opacity-60">{changeLabel()}</span>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            disabled={current._tag === "Saving" || current._tag === "Deleting"}
            onclick={() => {
              apply({ kind: "closeRequest" });
            }}
          >
            {canUpdate ? "Cancel" : "Close"}
          </button>
          {canUpdate ? (
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={
                changeCount === 0 ||
                current._tag === "Saving" ||
                current._tag === "Deleting"
              }
              onclick={() => {
                apply({ kind: "save" });
              }}
            >
              {current._tag === "Saving" ? "Saving…" : "Save"}
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
