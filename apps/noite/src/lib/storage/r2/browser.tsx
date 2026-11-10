//! One R2 folder: the page (toolbar, listing, pager, detail) and the cursor
//! stack that walks the store.
//!
//! The pager's cursor stack and the selection are explicit values (./folder);
//! upload, folder creation and delete share one write lifecycle (./write)
//! that knows which control is busy, and a partial upload is a state rather
//! than an error string. The selection is only ever resolved against the
//! *visible* listing, so a bulk delete can never remove an object the search
//! filtered away.

import { atom } from "ilha";

import { api } from "../../api";
import { formatBytes } from "../../bytes";
import { errorMessage } from "../../errors";
import { resourceError, resourceValue } from "../../resource";
import { invalidateR2, r2List } from "../../resources";
import { R2_UPLOAD_LIMIT } from "../../runner";
import { ChevronLeft, ChevronRight, Refresh, Search } from "../../ui/icons";
import { DetailPanel, EmptyState } from "../shared";
import { R2DetailPanel } from "./detail";
import {
  checkedVisible,
  cursorAt,
  emptySelection,
  nextFolder,
  nextSelection as nextSelectionState,
  prevFolder,
  r2Confirming,
  R2Sel,
  startFolder,
} from "./folder";
import type { FolderCursors, R2Selection } from "./folder";
import { R2ColumnRows, R2ListRows } from "./rows";
import { R2_VIEW_LABELS, R2_VIEWS } from "./state";
import type { R2View } from "./state";
import { NewFolderButton, UploadButton, putObject } from "./upload";
import {
  deleting,
  nextWrite,
  R2WriteState,
  writeProblem,
  writeRunning,
} from "./write";
import type { R2Write, R2WriteScope } from "./write";

const ViewSwitch = ({
  onPick,
  view,
}: {
  onPick: (view: R2View) => void;
  view: R2View;
}) => (
  <div class="join" role="group" aria-label="View">
    {R2_VIEWS.map((candidate) => (
      <button
        key={candidate}
        type="button"
        class={`btn btn-sm join-item ${view === candidate ? "btn-active" : ""}`}
        aria-pressed={view === candidate ? "true" : "false"}
        onclick={() => {
          onPick(candidate);
        }}
      >
        {R2_VIEW_LABELS[candidate]}
      </button>
    ))}
  </div>
);

/** The bulk-delete bar. One persistent Delete button arms the delete on the
 * first click and confirms it on the second; keeping the same node (and its
 * box) is what makes the two clicks deterministic for the e2e lane. */
const BulkDeleteBar = ({
  confirming,
  count,
  deleting: busy,
  onCancel,
  onClear,
  onDelete,
}: {
  confirming: boolean;
  count: number;
  deleting: boolean;
  onCancel: () => void;
  onClear: () => void;
  onDelete: () => void;
}) => (
  <div class="bg-base-200 dark:bg-base-300/50 flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
    <span class="font-medium">{count} selected</span>
    <button
      type="button"
      class="btn btn-sm btn-error"
      disabled={busy}
      onclick={onDelete}
    >
      {busy ? "Deleting…" : "Delete"}
    </button>
    {confirming ? (
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        disabled={busy}
        onclick={onCancel}
      >
        Cancel
      </button>
    ) : null}
    {confirming ? (
      <span class="text-error">
        Delete {count} object(s)? This cannot be undone.
      </span>
    ) : null}
    <button
      type="button"
      class="btn btn-sm btn-ghost ml-auto"
      disabled={busy}
      onclick={onClear}
    >
      Clear
    </button>
  </div>
);

/** One page of a folder: toolbar, browsers, pager and the detail panel. The
 * parent keys this by page, so the listing resource stays bound to the page
 * it was keyed with (see lib/resources). */
const R2Page = ({
  appId,
  bucket,
  canWrite,
  cursor,
  hasPrev,
  notify,
  onNext,
  onPrev,
  prefix,
  setView,
  view,
}: {
  appId: string;
  bucket: string;
  canWrite: boolean;
  cursor: string;
  hasPrev: boolean;
  notify: (text: string) => void;
  onNext: (cursor: string) => void;
  onPrev: () => void;
  prefix: string;
  setView: (view: R2View) => void;
  view: R2View;
}) => {
  const state = r2List(appId, bucket, prefix, cursor).state();
  const data = resourceValue(state);
  const loadError = resourceError(state);
  const selection = atom<R2Selection>(emptySelection());
  const write = atom<R2Write>(R2WriteState.Idle());
  const search = atom("");

  if (data === undefined) {
    if (state._tag === "Failed") {
      return (
        <p class="text-error m-0 p-4 text-sm">{errorMessage(state.error)}</p>
      );
    }

    return (
      <div class="flex flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-6 w-full" />
        <span class="skeleton h-6 w-full" />
      </div>
    );
  }

  /** Run one write: the machine owns the lifecycle, the listing always
   * refreshes so a partial result is visible, and the promise says whether
   * it fully succeeded (the new-folder form keeps its draft otherwise). */
  const run = async (
    scope: R2WriteScope,
    count: number,
    done: string,
    work: () => Promise<string[]>
  ): Promise<boolean> => {
    if (writeRunning(write())) {
      return false;
    }

    write.set(nextWrite(write(), { count, kind: "start", scope }));

    let problems: string[];

    try {
      problems = await work();
    } catch (error) {
      write.set(
        nextWrite(write(), { kind: "failed", message: errorMessage(error) })
      );

      return false;
    } finally {
      invalidateR2(appId, bucket);
    }

    write.set(nextWrite(write(), { kind: "settled", problems }));

    if (problems.length === 0) {
      notify(done);
    }

    return problems.length === 0;
  };

  const upload = (files: File[]) => {
    const uploadable = files.filter((file) => file.size <= R2_UPLOAD_LIMIT);
    const oversized = files.length - uploadable.length;

    void run(
      "upload",
      uploadable.length,
      `${uploadable.length} uploaded`,
      async () => {
        // One request per object (progress and failures stay per file), in
        // parallel so a multi-file selection is one round trip long.
        const attempts = await Promise.all(
          uploadable.map(async (file) => {
            try {
              await putObject(
                appId,
                bucket,
                `${prefix}${file.name}`,
                file,
                file.type || "application/octet-stream"
              );

              return null;
            } catch (error) {
              return `${file.name}: ${errorMessage(error)}`;
            }
          })
        );

        const failures = attempts.filter((message) => message !== null);
        const notes = [...failures];

        if (oversized > 0) {
          notes.unshift(
            `${oversized} file(s) exceed the ${formatBytes(R2_UPLOAD_LIMIT)} cap.`
          );
        }

        return notes;
      }
    );
  };

  const createFolder = (name: string) =>
    run("mkdir", 1, `Folder “${name}” created`, async () => {
      await putObject(
        appId,
        bucket,
        `${prefix}${name}/`,
        new Blob([]),
        "application/octet-stream"
      );

      return [];
    });

  const runDelete = (keys: readonly string[]) =>
    run("delete", keys.length, `${keys.length} deleted`, async () => {
      await api<{ ok: true }>("/api/storage/r2Delete", {
        appId,
        bucket,
        keys: [...keys],
      });

      const cleared = nextSelectionState(selection(), R2Sel.Clear());

      selection.set(
        keys.includes(cleared.focused ?? "")
          ? nextSelectionState(cleared, R2Sel.Focus({ key: null }))
          : cleared
      );

      return [];
    });

  const needle = search().trim().toLowerCase();

  const folders =
    needle === ""
      ? data.folders
      : data.folders.filter((folder) =>
          folder.name.toLowerCase().includes(needle)
        );

  const files =
    needle === ""
      ? data.objects
      : data.objects.filter((object) =>
          object.name.toLowerCase().includes(needle)
        );

  const visibleKeys = files.map((object) => object.key);
  const checkedKeys = checkedVisible(selection(), visibleKeys);
  const checkedSet = new Set(selection().checked);
  const { focused } = selection();
  const selectedObject = data.objects.find((o) => o.key === focused) ?? null;

  let browser = (
    <EmptyState
      action={
        <UploadButton
          busy={writeRunning(write())}
          disabled={!canWrite}
          onUpload={upload}
        />
      }
      hint={
        prefix === ""
          ? "Upload a file, or PUT one from the app at /files/<key>."
          : "This folder is empty — upload a file into it."
      }
      title="Nothing here yet"
    />
  );

  if (data.folders.length > 0 || data.objects.length > 0) {
    browser =
      view === "list" ? (
        <R2ListRows
          appId={appId}
          bucket={bucket}
          canWrite={canWrite}
          checked={checkedSet}
          files={files}
          folders={folders}
          onOpen={(key) => {
            selection.set(
              nextSelectionState(selection(), R2Sel.Focus({ key }))
            );
          }}
          onToggle={(key, on) => {
            selection.set(
              nextSelectionState(selection(), R2Sel.Toggle({ key, on }))
            );
          }}
          onToggleAll={() => {
            selection.set(
              nextSelectionState(
                selection(),
                R2Sel.ToggleAll({ visible: visibleKeys })
              )
            );
          }}
          selected={focused}
        />
      ) : (
        <R2ColumnRows
          appId={appId}
          bucket={bucket}
          canWrite={canWrite}
          checked={checkedSet}
          files={files}
          folders={folders}
          onOpen={(key) => {
            selection.set(
              nextSelectionState(selection(), R2Sel.Focus({ key }))
            );
          }}
          onToggle={(key, on) => {
            selection.set(
              nextSelectionState(selection(), R2Sel.Toggle({ key, on }))
            );
          }}
          selected={focused}
        />
      );
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <label class="input input-sm w-56 max-w-full">
          <Search class="h-4 w-4 opacity-50" />
          <input
            type="search"
            aria-label="Search in this folder"
            placeholder="Search in this folder…"
            value={search()}
            oninput={(event) => {
              search.set(event.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          class="btn btn-square btn-ghost btn-sm"
          aria-label="Refresh"
          title="Refresh"
          onclick={() => {
            invalidateR2(appId, bucket);
          }}
        >
          <Refresh />
        </button>
        <ViewSwitch onPick={setView} view={view} />
        <div class="ml-auto flex items-center gap-2">
          <NewFolderButton
            busy={writeRunning(write())}
            disabled={!canWrite}
            onCreate={createFolder}
          />
          <UploadButton
            busy={writeRunning(write())}
            disabled={!canWrite}
            onUpload={upload}
          />
        </div>
      </div>
      {state._tag === "Failed" ? (
        <p class="text-error m-0 px-3 py-1 text-sm" role="alert">
          {errorMessage(state.error)} — showing the last loaded page.
        </p>
      ) : null}
      {writeProblem(write()) === null ? null : (
        <p class="text-error m-0 px-3 py-1 text-sm whitespace-pre-wrap">
          {writeProblem(write())}
        </p>
      )}
      {checkedKeys.length > 0 && canWrite ? (
        <BulkDeleteBar
          confirming={r2Confirming(selection())}
          count={checkedKeys.length}
          deleting={deleting(write())}
          onCancel={() => {
            selection.set(nextSelectionState(selection(), R2Sel.CancelArm()));
          }}
          onClear={() => {
            selection.set(nextSelectionState(selection(), R2Sel.Clear()));
          }}
          onDelete={() => {
            if (r2Confirming(selection())) {
              void runDelete(checkedKeys);

              return;
            }

            selection.set(nextSelectionState(selection(), R2Sel.Arm()));
          }}
        />
      ) : null}
      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          {browser}
          <div class="border-base-300 flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm">
            <span class="opacity-60">
              {data.folders.length} folder
              {data.folders.length === 1 ? "" : "s"} · {data.objects.length}{" "}
              file
              {data.objects.length === 1 ? "" : "s"}
            </span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="btn btn-square btn-ghost btn-sm"
                aria-label="Previous page"
                disabled={!hasPrev}
                onclick={onPrev}
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                class="btn btn-square btn-ghost btn-sm"
                aria-label="Next page"
                disabled={data.nextCursor === null}
                onclick={() => {
                  if (data.nextCursor !== null) {
                    onNext(data.nextCursor);
                  }
                }}
              >
                <ChevronRight />
              </button>
            </div>
          </div>
        </div>
        {selectedObject === null ? (
          <DetailPanel title="Details">
            <p class="m-0 text-sm opacity-60">
              {loadError === undefined
                ? "Select a file to preview it, download it or copy its URL."
                : "The selected file is no longer in this folder."}
            </p>
          </DetailPanel>
        ) : (
          <R2DetailPanel
            key={selectedObject.key}
            appId={appId}
            bucket={bucket}
            busy={deleting(write())}
            canWrite={canWrite}
            object={selectedObject}
            onDelete={(key) => {
              void runDelete([key]);
            }}
          />
        )}
      </div>
    </div>
  );
};

/** One bucket folder: the page plus the cursor stack that walks the store
 * (the runner returns a continuation token per page). Keyed by prefix in
 * R2Browser, so entering a folder starts at its first page. */
export const R2Folder = ({
  appId,
  bucket,
  canWrite,
  notify,
  prefix,
  setView,
  view,
}: {
  appId: string;
  bucket: string;
  canWrite: boolean;
  notify: (text: string) => void;
  prefix: string;
  setView: (view: R2View) => void;
  view: R2View;
}) => {
  const folder = atom<FolderCursors>(startFolder());
  const at = folder();

  return (
    <R2Page
      key={at.index}
      appId={appId}
      bucket={bucket}
      canWrite={canWrite}
      cursor={cursorAt(at)}
      hasPrev={at.index > 0}
      notify={notify}
      onNext={(next) => {
        folder.set(nextFolder(at, next));
      }}
      onPrev={() => {
        folder.set(prevFolder(at));
      }}
      prefix={prefix}
      setView={setView}
      view={view}
    />
  );
};
