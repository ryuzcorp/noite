//! One R2 folder: the page (toolbar, listing, pager, detail) and the cursor
//! stack that walks the store.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { invalidateR2, r2List } from "../../resources";
import { R2_UPLOAD_LIMIT } from "../../runner";
import { r2Delete } from "../../server/storage.server";
import { ChevronLeft, ChevronRight, Refresh, Search } from "../../ui/icons";
import { DetailPanel, EmptyState, formatBytes } from "../shared";
import { R2DetailPanel } from "./detail";
import { R2ColumnRows, R2ListRows } from "./rows";
import { R2_VIEW_LABELS, R2_VIEWS, toggledKey } from "./state";
import type { R2View } from "./state";
import { NewFolderButton, UploadButton, putObject } from "./upload";

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
  const res = r2List(appId, bucket, prefix, cursor);
  const search = atom("");
  const selected = atom<string | null>(null);
  const checked = atom<Set<string>>(new Set<string>());
  const confirming = atom(false);
  const busy = atom(false);
  const failure = atom("");

  const data = res.data();
  const loadError = res.error();
  if (loadError && data === undefined) {
    return <p class="text-error m-0 p-4 text-sm">{errorMessage(loadError)}</p>;
  }
  if (!data) {
    return (
      <div class="flex flex-col gap-2 p-4">
        <span class="skeleton h-8 w-full" />
        <span class="skeleton h-6 w-full" />
        <span class="skeleton h-6 w-full" />
      </div>
    );
  }

  /** Run a write; `run` returns a problem message (null when it worked), and
   * the listing refreshes either way so a partial result is visible. */
  const write = async (
    run: () => Promise<string | null>,
    done: string
  ): Promise<void> => {
    if (busy()) {
      return;
    }
    busy.set(true);
    failure.set("");
    try {
      const problem = await run();
      invalidateR2(appId, bucket);
      if (problem === null) {
        notify(done);
      } else {
        failure.set(problem);
      }
    } catch (error) {
      failure.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  const upload = (files: File[]) => {
    const uploadable = files.filter((file) => file.size <= R2_UPLOAD_LIMIT);
    const oversized = files.length - uploadable.length;
    void write(
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
        return notes.length > 0 ? notes.join("\n") : null;
      },
      `${uploadable.length} file${uploadable.length === 1 ? "" : "s"} uploaded`
    );
  };

  const createFolder = (name: string) => {
    void write(async () => {
      await putObject(
        appId,
        bucket,
        `${prefix}${name}/`,
        new Blob([]),
        "application/octet-stream"
      );
      return null;
    }, `Folder “${name}” created`);
  };

  const runDelete = (keys: string[]) => {
    void write(
      async () => {
        await r2Delete({ appId, bucket, keys });
        checked.set(new Set());
        confirming.set(false);
        if (keys.includes(selected() ?? "")) {
          selected.set(null);
        }
        return null;
      },
      `${keys.length} object${keys.length === 1 ? "" : "s"} deleted`
    );
  };

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
  const checkedKeys = [...checked()];
  const selectedObject = data.objects.find((o) => o.key === selected()) ?? null;

  let browser = (
    <EmptyState
      action={
        <UploadButton busy={busy()} disabled={!canWrite} onUpload={upload} />
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
          checked={checked()}
          files={files}
          folders={folders}
          onOpen={(key) => {
            selected.set(key);
          }}
          onToggle={(key, on) => {
            checked.set(toggledKey(checked(), key, on));
          }}
          onToggleAll={(on) => {
            checked.set(
              on ? new Set(files.map((object) => object.key)) : new Set()
            );
          }}
          selected={selected()}
        />
      ) : (
        <R2ColumnRows
          appId={appId}
          bucket={bucket}
          canWrite={canWrite}
          checked={checked()}
          files={files}
          folders={folders}
          onOpen={(key) => {
            selected.set(key);
          }}
          onToggle={(key, on) => {
            checked.set(toggledKey(checked(), key, on));
          }}
          selected={selected()}
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
            busy={busy()}
            disabled={!canWrite}
            onCreate={createFolder}
          />
          <UploadButton busy={busy()} disabled={!canWrite} onUpload={upload} />
        </div>
      </div>
      {failure() ? (
        <p class="text-error m-0 px-3 py-1 text-sm whitespace-pre-wrap">
          {failure()}
        </p>
      ) : null}
      {checkedKeys.length > 0 && canWrite ? (
        <div class="bg-base-200 dark:bg-base-300/50 flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
          <span class="font-medium">{checkedKeys.length} selected</span>
          {confirming() ? (
            <>
              <span class="text-error">
                Delete {checkedKeys.length} object(s)? This cannot be undone.
              </span>
              <button
                type="button"
                class="btn btn-sm btn-error"
                disabled={busy()}
                onclick={() => {
                  runDelete(checkedKeys);
                }}
              >
                {busy() ? "Deleting…" : "Delete"}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                disabled={busy()}
                onclick={() => {
                  confirming.set(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onclick={() => {
                confirming.set(true);
              }}
            >
              Delete
            </button>
          )}
          <button
            type="button"
            class="btn btn-sm btn-ghost ml-auto"
            onclick={() => {
              checked.set(new Set());
              confirming.set(false);
            }}
          >
            Clear
          </button>
        </div>
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
              Select a file to preview it, download it or copy its URL.
            </p>
          </DetailPanel>
        ) : (
          <R2DetailPanel
            key={selectedObject.key}
            appId={appId}
            bucket={bucket}
            busy={busy()}
            canWrite={canWrite}
            object={selectedObject}
            onDelete={(key) => {
              runDelete([key]);
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
  const cursors = atom<string[]>([""]);
  const pageIndex = atom(0);
  const at = Math.min(pageIndex(), cursors().length - 1);
  return (
    <R2Page
      key={at}
      appId={appId}
      bucket={bucket}
      canWrite={canWrite}
      cursor={cursors()[at] ?? ""}
      hasPrev={at > 0}
      notify={notify}
      onNext={(next) => {
        cursors.set([...cursors().slice(0, at + 1), next]);
        pageIndex.set(at + 1);
      }}
      onPrev={() => {
        pageIndex.set(Math.max(at - 1, 0));
      }}
      prefix={prefix}
      setView={setView}
      view={view}
    />
  );
};
