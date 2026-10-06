//! The R2 object browser (Supabase Storage → Files → bucket): a breadcrumb
//! header, a folder toolbar, a prefix/delimiter listing with multi-select,
//! and a detail panel for the selected object (preview, download, copy URL,
//! delete). Writes — upload and New folder — stream to the UI's proxy route,
//! which hands the body to the runner's `celld r2 put`, so the stored record
//! is exactly what a Worker's `env.BUCKET.put()` writes.

import { searchParam } from "@ilha/router";
import { atom } from "ilha";

import { r2Delete } from "../../apps.server";
import { formatAgo, formatDateTime } from "../../dates";
import { errorMessage } from "../../errors";
import {
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Download,
  FileIcon,
  Folder,
  ImageIcon,
  Refresh,
  Search,
  Trash,
} from "../../icons";
import { collectRef, liveEl, newLiveRef } from "../../live-ref";
import { invalidateR2, r2File, r2List } from "../../resources";
import { R2_UPLOAD_LIMIT, r2DownloadUrl, r2UploadUrl } from "../../runner";
import type { R2Object, R2Preview } from "../../runner";
import {
  CopyButton,
  DetailPanel,
  EmptyState,
  formatBytes,
  prettyJson,
  previewKind,
  StorageBreadcrumb,
  Toaster,
  useToasts,
} from "../shared";
import type { PreviewKind } from "../shared";
import {
  R2_VIEW_LABELS,
  R2_VIEWS,
  r2Crumbs,
  r2Href,
  toR2View,
  toggledKey,
} from "./state";
import type { R2View } from "./state";

/** Stream one object through the UI's upload proxy (the runner spools it and
 * calls `celld r2 put`); throws the server's message when it refuses. */
const putObject = async (
  appId: string,
  bucket: string,
  key: string,
  body: Blob | File,
  contentType: string
): Promise<void> => {
  const response = await fetch(r2UploadUrl(appId, bucket, key), {
    body,
    headers: { "content-type": contentType },
    method: "PUT",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(
      detail || `the store refused the write (${response.status})`
    );
  }
};

const FileTypeIcon = ({ kind }: { kind: PreviewKind }) => {
  if (kind === "image") {
    return <ImageIcon class="h-4 w-4 shrink-0 opacity-60" />;
  }
  return <FileIcon class="h-4 w-4 shrink-0 opacity-60" />;
};

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

/** Create-folder popover: one name, validated here and again by the runner
 * (which stores a zero-byte marker object at `<prefix><name>/`). */
const NewFolderButton = ({
  busy,
  disabled,
  onCreate,
}: {
  busy: boolean;
  disabled: boolean;
  onCreate: (name: string) => void;
}) => {
  const name = atom("");
  const details = atom.lazy(newLiveRef<HTMLDetailsElement>)();
  const close = () => {
    const element = liveEl(details);
    if (element) {
      element.open = false;
    }
  };
  const cleaned = name().trim();
  const invalid =
    cleaned !== "" &&
    (cleaned.includes("/") || cleaned === ".." || cleaned === ".");
  const valid = cleaned !== "" && !invalid;
  return (
    <details
      class="dropdown dropdown-end"
      ref={(el) => {
        collectRef(details, el);
      }}
    >
      <summary
        class="btn btn-sm btn-ghost gap-1"
        aria-label="Create folder"
        title="Create folder"
      >
        <Folder />
        <span class="hidden sm:inline">New folder</span>
      </summary>
      <div class="dropdown-content bg-base-100 dark:bg-base-200 border-base-300 rounded-box z-50 mt-1 w-72 border p-3 shadow-lg">
        <label class="flex flex-col gap-1 text-sm" for="r2-new-folder">
          Folder name
          <input
            id="r2-new-folder"
            class="input input-sm"
            type="text"
            placeholder="photos"
            value={name()}
            oninput={(event) => {
              name.set(event.currentTarget.value);
            }}
          />
        </label>
        {invalid ? (
          <p class="text-error m-0 mt-1 text-xs">
            A folder name cannot contain a slash.
          </p>
        ) : null}
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" class="btn btn-sm btn-ghost" onclick={close}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-sm btn-neutral"
            disabled={busy || disabled || !valid}
            onclick={() => {
              if (!valid) {
                return;
              }
              onCreate(cleaned);
              name.set("");
              close();
            }}
          >
            Create
          </button>
        </div>
      </div>
    </details>
  );
};

/** Upload button: a hidden multi-file input (uncontrolled — a file input
 * cannot be driven by value) triggered from a real button. */
const UploadButton = ({
  busy,
  disabled,
  onUpload,
}: {
  busy: boolean;
  disabled: boolean;
  onUpload: (files: File[]) => void;
}) => {
  const input = atom.lazy(newLiveRef<HTMLInputElement>)();
  return (
    <>
      <input
        class="hidden"
        multiple
        ref={(el) => {
          collectRef(input, el);
        }}
        type="file"
        onchange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // Reset so picking the same file again still fires a change.
          event.currentTarget.value = "";
          if (files.length > 0) {
            onUpload(files);
          }
        }}
      />
      <button
        type="button"
        class="btn btn-sm btn-neutral gap-1"
        disabled={busy || disabled}
        title={disabled ? "Upload requires the push role" : "Upload files"}
        onclick={() => {
          liveEl(input)?.click();
        }}
      >
        <CloudUpload class="h-4 w-4" />
        Upload
      </button>
    </>
  );
};

/** Bounded text/JSON preview of one object (the runner sends at most 256 KiB
 * and null for a binary body). Keyed by the object key in the panel, so the
 * resource stays bound to one file for the life of the fiber. */
const R2TextPreview = ({
  appId,
  bucket,
  object,
}: {
  appId: string;
  bucket: string;
  object: R2Object;
}) => {
  const res = r2File(appId, bucket, object.key);
  const data = res.data();
  const loadError = res.error();
  if (loadError && data === undefined) {
    return <p class="text-error m-0 text-sm">{errorMessage(loadError)}</p>;
  }
  if (!data) {
    return <span class="skeleton h-24 w-full" />;
  }
  if (data.text === null) {
    return (
      <p class="m-0 text-sm opacity-60">
        This object is not UTF-8 text, so there is nothing to preview.
      </p>
    );
  }
  const isJson =
    (object.contentType ?? "").includes("json") ||
    (data.contentType ?? "").includes("json");
  const body = isJson ? prettyJson(data.text) : data.text;
  return (
    <div class="flex flex-col gap-1">
      <pre class="bg-base-200 dark:bg-base-300/50 m-0 max-h-64 overflow-auto rounded-lg p-2 text-xs whitespace-pre-wrap">
        {body}
      </pre>
      {data.truncated ? (
        <p class="m-0 text-xs opacity-60">
          Preview truncated — download the file for the whole body.
        </p>
      ) : null}
    </div>
  );
};

/** Delete control for one object: two steps, inline (no browser dialog). */
const DeleteFileButton = ({
  busy,
  onDelete,
}: {
  busy: boolean;
  onDelete: () => void;
}) => {
  const confirming = atom(false);
  if (!confirming()) {
    return (
      <button
        type="button"
        class="btn btn-sm btn-ghost text-error gap-1"
        onclick={() => {
          confirming.set(true);
        }}
      >
        <Trash class="h-4 w-4" />
        Delete
      </button>
    );
  }
  return (
    <span class="flex items-center gap-2">
      <span class="text-error text-sm">Delete this file?</span>
      <button
        type="button"
        class="btn btn-sm btn-error"
        disabled={busy}
        onclick={onDelete}
      >
        Delete
      </button>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        onclick={() => {
          confirming.set(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
};

/** The one object the detail panel shows: preview, record, actions. */
const R2DetailPanel = ({
  appId,
  bucket,
  busy,
  canWrite,
  object,
  onDelete,
}: {
  appId: string;
  bucket: string;
  busy: boolean;
  canWrite: boolean;
  object: R2Object;
  onDelete: (key: string) => void;
}) => {
  const url = r2DownloadUrl(appId, bucket, object.key);
  const kind = previewKind(object.contentType);
  return (
    <DetailPanel title={object.name}>
      {kind === "image" ? (
        <div class="border-base-300 flex items-center justify-center rounded-lg border p-2">
          <img
            alt={object.name}
            class="max-h-64 object-contain"
            loading="lazy"
            src={url}
          />
        </div>
      ) : null}
      {kind === "text" ? (
        <R2TextPreview
          key={object.key}
          appId={appId}
          bucket={bucket}
          object={object}
        />
      ) : null}
      {kind === "binary" ? (
        <p class="m-0 text-sm opacity-60">
          No preview for this type — download it to inspect the bytes.
        </p>
      ) : null}
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="opacity-60">Type</dt>
        <dd class="m-0 truncate font-mono text-xs">
          {object.contentType ?? "—"}
        </dd>
        <dt class="opacity-60">Size</dt>
        <dd class="m-0">{formatBytes(object.size)}</dd>
        <dt class="opacity-60">Last modified</dt>
        <dd class="m-0" title={formatDateTime(object.lastModified)}>
          {formatAgo(object.lastModified)}
        </dd>
        <dt class="opacity-60">ETag</dt>
        <dd class="m-0 truncate font-mono text-xs">{object.etag ?? "—"}</dd>
      </dl>
      <div class="mt-auto flex flex-wrap items-center gap-2">
        <a
          class="btn btn-sm btn-neutral gap-1"
          download={object.name}
          href={url}
        >
          <Download class="h-4 w-4" />
          Download
        </a>
        <CopyButton label={`Copy URL for ${object.name}`} value={url} />
        {canWrite ? (
          <DeleteFileButton
            busy={busy}
            onDelete={() => {
              onDelete(object.key);
            }}
          />
        ) : null}
      </div>
    </DetailPanel>
  );
};

/** List view: a table of the current folder, folders first, with a checkbox
 * per file and the multi-select bar above it. */
const R2ListRows = ({
  appId,
  bucket,
  canWrite,
  checked,
  files,
  folders,
  onOpen,
  onToggle,
  onToggleAll,
  selected,
}: {
  appId: string;
  bucket: string;
  canWrite: boolean;
  checked: Set<string>;
  files: R2Object[];
  folders: R2Preview["folders"];
  onOpen: (key: string) => void;
  onToggle: (key: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  selected: string | null;
}) => {
  const allChecked =
    files.length > 0 && files.every((object) => checked.has(object.key));
  return (
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="table-sm table-pin-rows table w-full">
        <thead>
          <tr>
            {canWrite ? (
              <th class="w-10">
                <input
                  class="checkbox checkbox-sm"
                  type="checkbox"
                  aria-label="Select all files on this page"
                  checked={allChecked}
                  onchange={(event) => {
                    onToggleAll(event.currentTarget.checked);
                  }}
                />
              </th>
            ) : null}
            <th class="whitespace-nowrap">Name</th>
            <th class="whitespace-nowrap">Type</th>
            <th class="whitespace-nowrap">Size</th>
            <th class="whitespace-nowrap">Last modified</th>
          </tr>
        </thead>
        <tbody>
          {folders.map((folder) => (
            <tr key={folder.prefix} class="hover">
              {canWrite ? <td /> : null}
              <td class="max-w-md">
                <a
                  class="link link-hover inline-flex min-w-0 items-center gap-2"
                  href={r2Href(appId, bucket, folder.prefix)}
                >
                  <Folder class="h-4 w-4 shrink-0 opacity-60" />
                  <span class="truncate">{folder.name}</span>
                </a>
              </td>
              <td class="text-xs opacity-60">Folder</td>
              <td class="text-xs opacity-60">—</td>
              <td class="text-xs opacity-60">—</td>
            </tr>
          ))}
          {files.map((object) => (
            <tr
              key={object.key}
              class={`hover cursor-pointer ${selected === object.key ? "bg-base-200 dark:bg-base-300/50" : ""}`}
              onclick={() => {
                onOpen(object.key);
              }}
            >
              {canWrite ? (
                <td
                  onclick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <input
                    class="checkbox checkbox-sm"
                    type="checkbox"
                    aria-label={`Select ${object.name}`}
                    checked={checked.has(object.key)}
                    onchange={(event) => {
                      onToggle(object.key, event.currentTarget.checked);
                    }}
                  />
                </td>
              ) : null}
              <td class="max-w-md">
                <span class="flex min-w-0 items-center gap-2">
                  <FileTypeIcon kind={previewKind(object.contentType)} />
                  <span class="truncate" title={object.key}>
                    {object.name}
                  </span>
                </span>
              </td>
              <td class="text-xs opacity-70">{object.contentType ?? "—"}</td>
              <td class="text-xs tabular-nums">{formatBytes(object.size)}</td>
              <td
                class="text-xs whitespace-nowrap"
                title={formatDateTime(object.lastModified)}
              >
                {formatAgo(object.lastModified)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** Columns view: the same folder as one dense column beside the detail
 * panel — the compact presentation of a large listing. */
const R2ColumnRows = ({
  appId,
  bucket,
  canWrite,
  checked,
  files,
  folders,
  onOpen,
  onToggle,
  selected,
}: {
  appId: string;
  bucket: string;
  canWrite: boolean;
  checked: Set<string>;
  files: R2Object[];
  folders: R2Preview["folders"];
  onOpen: (key: string) => void;
  onToggle: (key: string, on: boolean) => void;
  selected: string | null;
}) => (
  <div class="min-h-0 flex-1 overflow-auto">
    <ul class="menu m-0 w-full gap-0.5 p-2">
      {folders.map((folder) => (
        <li key={folder.prefix}>
          <a
            class="gap-2"
            href={r2Href(appId, bucket, folder.prefix)}
            title={folder.prefix}
          >
            <Folder class="h-4 w-4 shrink-0 opacity-60" />
            <span class="min-w-0 flex-1 truncate">{folder.name}</span>
          </a>
        </li>
      ))}
      {files.map((object) => (
        <li key={object.key}>
          <button
            type="button"
            class={`gap-2 text-left ${selected === object.key ? "menu-active" : ""}`}
            onclick={() => {
              onOpen(object.key);
            }}
          >
            {canWrite ? (
              <input
                class="checkbox checkbox-sm"
                type="checkbox"
                aria-label={`Select ${object.name}`}
                checked={checked.has(object.key)}
                onclick={(event) => {
                  event.stopPropagation();
                  onToggle(object.key, event.currentTarget.checked);
                }}
              />
            ) : null}
            <FileTypeIcon kind={previewKind(object.contentType)} />
            <span class="min-w-0 flex-1 truncate" title={object.key}>
              {object.name}
            </span>
            <span class="shrink-0 text-xs tabular-nums opacity-50">
              {formatBytes(object.size)}
            </span>
          </button>
        </li>
      ))}
    </ul>
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
const R2Folder = ({
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

/** One R2 bucket: breadcrumb header, then the folder view. */
export const R2Browser = ({
  appId,
  appName,
  bucket,
  canWrite,
}: {
  appId: string;
  appName: string;
  bucket: string;
  canWrite: boolean;
}) => {
  const prefix = searchParam("p", { default: "" });
  const viewParam = searchParam<R2View>("v", {
    default: "list",
    parse: toR2View,
  });
  const { notify, toasts } = useToasts();
  return (
    <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div class="border-base-300 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        <StorageBreadcrumb
          crumbs={r2Crumbs(appId, appName, bucket, prefix())}
        />
        <span class="badge badge-sm ml-auto shrink-0">R2</span>
      </div>
      <R2Folder
        key={prefix()}
        appId={appId}
        bucket={bucket}
        canWrite={canWrite}
        notify={notify}
        prefix={prefix()}
        setView={(next) => {
          viewParam.set(next);
        }}
        view={viewParam()}
      />
      <Toaster toasts={toasts()} />
    </div>
  );
};
