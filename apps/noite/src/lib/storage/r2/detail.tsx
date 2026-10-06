//! R2 detail panel: preview plus metadata, download, copy URL and delete.

import { atom } from "ilha";

import { formatAgo, formatDateTime } from "../../dates";
import { r2DownloadUrl } from "../../runner";
import type { R2Object } from "../../runner";
import { CopyButton } from "../../ui/copy-button";
import { Download, Trash } from "../../ui/icons";
import { DetailPanel, formatBytes, previewKind } from "../shared";
import { R2TextPreview } from "./preview";

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
export const R2DetailPanel = ({
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
