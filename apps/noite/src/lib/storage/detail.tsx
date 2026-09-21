//! Single-resource detail: D1 tables, DO instances, R2 keys + previews.
import { atom, watch } from "ilha";

import { d1Preview, doPreview, r2Delete, r2List } from "../apps.server";
import { r2DownloadUrl } from "../runner";
import type { D1Preview, DoPreview, R2Preview } from "../runner";
import { SectionSkeleton } from "../skeletons";
import { D1DetailPanel } from "./d1";

/** One storage resource's details: D1 shows each table as a read-only
 * daisyUI table (rows + first rows); a DO class shows its live instances;
 * an R2 bucket lists keys with a bounded text preview per file.
 * celld exposes no read route for a DO instance's stored data, so the
 * instance enumeration is the operator's view. */
export const StorageDetail = ({
  appId,
  resourceId,
}: {
  appId: string;
  resourceId: string;
}) => {
  const isD1 = resourceId.startsWith("d1:");
  const isR2 = resourceId.startsWith("r2:");
  const databaseId = isD1 ? resourceId.slice(3) : resourceId;
  const bucket = isR2 ? resourceId.slice(3) : resourceId;
  // DO resource ids are "do:{Binding}:{Name}" — the class is everything
  // after the binding, and either part may itself contain a colon.
  const className = resourceId.startsWith("do:")
    ? resourceId.split(":").slice(2).join(":")
    : resourceId;
  const preview = atom<D1Preview | DoPreview | R2Preview | null>(null);
  const fileError = atom("");
  const loadError = atom("");

  const reloadR2 = async () => {
    try {
      const p = await r2List({ appId, bucket });
      // SAFETY: same unwrap edge as the D1 branch — raw R2Preview JSON.
      preview.set((p as R2Preview | null) ?? null);
      fileError.set("");
    } catch (error) {
      fileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteFile = async (key: string) => {
    // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
    if (!window.confirm(`Delete ${key} from ${bucket}?`)) {
      return;
    }
    try {
      await r2Delete({ appId, bucket, key });
      await reloadR2();
    } catch (error) {
      fileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  // D1 preview reload (picker/role/drawer live in D1DetailPanel).
  const reloadD1 = async () => {
    const p = await d1Preview({ appId, databaseId });
    // SAFETY: oxide action returns unwrap to the raw runner JSON here
    // (D1Preview); the `Effect<...>` variant is the action's typing edge
    // that erases at runtime.
    preview.set((p as D1Preview | null) ?? null);
  };

  watch.once(() => {
    void (async () => {
      try {
        if (isR2) {
          await reloadR2();
        } else if (isD1) {
          await reloadD1();
        } else if (resourceId.startsWith("do:")) {
          const p = await doPreview({ appId, className });
          // SAFETY: the doPreview action returns the runner's DoPreview as
          // unwrap (raw JSON), the same typing edge as the D1 branch above.
          preview.set((p as DoPreview | null) ?? null);
        }
      } catch (error) {
        loadError.set(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  if (loadError()) {
    return <p class="text-error m-0 text-sm">{loadError()}</p>;
  }
  if (!preview()) {
    return <SectionSkeleton lines={5} />;
  }
  const p = preview();
  if (!p) {
    return null;
  }

  if (isR2) {
    // SAFETY: reached only when isR2, where the watch branch stores an
    // R2Preview (the union covers the D1/DO siblings in the same atom).
    const r2Data = p as R2Preview;
    return (
      <div class="flex flex-col gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="badge">R2</span>
            <h1 class="m-0 text-lg font-semibold">{bucket}</h1>
          </div>
          <p class="m-0 text-sm opacity-70">
            {r2Data.objects.length} object(s)
          </p>
        </div>
        {r2Data.objects.length === 0 ? (
          <p class="m-0 text-sm opacity-70">
            No objects yet — PUT to /files/&lt;key&gt; on the app to upload one.
          </p>
        ) : (
          <div class="card bg-base-100 dark:bg-base-200 border-base-300 border shadow-md">
            <div class="card-body gap-4">
              <div class="overflow-x-auto">
                <table class="table-sm table-zebra table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Size</th>
                      <th>Uploaded</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {r2Data.objects.map((object) => (
                      <tr key={object.key}>
                        <td class="font-mono text-xs">{object.key}</td>
                        <td class="font-mono text-xs">{object.size}</td>
                        <td class="font-mono text-xs">
                          {object.lastModified || "—"}
                        </td>
                        <td class="whitespace-nowrap">
                          <a
                            class="btn btn-sm btn-ghost"
                            href={r2DownloadUrl(appId, bucket, object.key)}
                            download={object.key.split("/").pop() ?? object.key}
                          >
                            Download
                          </a>
                          <button
                            type="button"
                            class="btn btn-sm btn-ghost text-error"
                            onclick={() => {
                              void deleteFile(object.key);
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {fileError() ? (
          <p class="text-error m-0 text-sm">{fileError()}</p>
        ) : null}
      </div>
    );
  }

  if (!isD1) {
    // SAFETY: this branch only ever stored a DoPreview (the do: watch branch
    // above); the atom base type unions D1Preview in for the D1 sibling.
    const doData = p as DoPreview;
    return (
      <div class="flex flex-col gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="badge">DO</span>
            <h1 class="m-0 text-lg font-semibold">{className}</h1>
          </div>
          <p class="m-0 text-sm opacity-70">
            {doData.instances.length} instance(s)
          </p>
        </div>
        {doData.instances.length === 0 ? (
          <p class="m-0 text-sm opacity-70">
            No instances yet — one is created the first time the object is
            called.
          </p>
        ) : (
          <div class="card bg-base-100 dark:bg-base-200 border-base-300 border shadow-md">
            <div class="card-body gap-4">
              <div class="overflow-x-auto">
                <table class="table-sm table-zebra table">
                  <thead>
                    <tr>
                      <th>Instance ID</th>
                      <th>Preview (?read=1)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doData.instances.map((instance) => (
                      <tr key={instance.id}>
                        <td class="font-mono text-xs">{instance.id}</td>
                        <td class="font-mono text-xs whitespace-pre-wrap">
                          {instance.preview ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // SAFETY: reached only when isD1, where the watch branch stores a
  // D1Preview (the union is DoPreview's sibling in the same atom).
  const d1Data = p as D1Preview;
  return (
    <D1DetailPanel
      appId={appId}
      databaseId={databaseId}
      d1Data={d1Data}
      onSaved={() => {
        void reloadD1();
      }}
    />
  );
};
