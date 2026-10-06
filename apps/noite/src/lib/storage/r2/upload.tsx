//! R2 writes: the streamed put helper and the toolbar controls that use it
//! (upload files, create a folder marker).

import { atom } from "ilha";

import { collectRef, liveEl, newLiveRef } from "../../live-ref";
import { r2UploadUrl } from "../../runner";
import { CloudUpload, Folder } from "../../ui/icons";

/** Stream one object through the UI's upload proxy (the runner spools it and
 * calls `celld r2 put`); throws the server's message when it refuses. */
export const putObject = async (
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

/** Create-folder popover: one name, validated here and again by the runner
 * (which stores a zero-byte marker object at `<prefix><name>/`). */
export const NewFolderButton = ({
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
export const UploadButton = ({
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
