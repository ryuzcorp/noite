//! Single-resource detail: D1 tables, DO instances, R2 keys + previews.
import { atom } from "ilha";

import { r2Delete } from "../apps.server";
import { formatDateTime } from "../dates";
import { appDetail, d1Preview, doPreview, r2List } from "../resources";
import { r2DownloadUrl } from "../runner";
import { SectionSkeleton } from "../skeletons";
import { D1DetailPanel } from "./d1";
import { StorageTopCard } from "./list";

/** R2 bucket keys with a bounded text preview per file. */
const R2Detail = ({
  appId,
  appName,
  bucket,
}: {
  appId: string;
  appName: string;
  bucket: string;
}) => {
  const res = r2List(appId, bucket);
  const fileError = atom("");

  const deleteFile = async (key: string) => {
    // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
    if (!window.confirm(`Delete ${key} from ${bucket}?`)) {
      return;
    }
    try {
      await r2Delete({ appId, bucket, key });
      await res.refetch();
    } catch (error) {
      fileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  const loadError = res.error();
  if (loadError && res.data() === undefined) {
    return <p class="text-error m-0 text-sm">{String(loadError)}</p>;
  }
  const r2Data = res.data();
  if (!r2Data) {
    return <SectionSkeleton lines={5} />;
  }
  return (
    <div class="flex flex-col gap-4">
      <StorageTopCard
        appId={appId}
        appName={appName}
        badge="R2"
        subtitle={`${r2Data.objects.length} object(s)`}
        title={bucket}
      />
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
                        {formatDateTime(object.lastModified)}
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
      {fileError() ? <p class="text-error m-0 text-sm">{fileError()}</p> : null}
    </div>
  );
};

/** Durable Object class instances. celld exposes no read route for an
 * instance's stored data, so the instance enumeration is the view. */
const DoDetail = ({
  appId,
  appName,
  className,
}: {
  appId: string;
  appName: string;
  className: string;
}) => {
  const res = doPreview(appId, className);
  const loadError = res.error();
  if (loadError && res.data() === undefined) {
    return <p class="text-error m-0 text-sm">{String(loadError)}</p>;
  }
  const doData = res.data();
  if (!doData) {
    return <SectionSkeleton lines={5} />;
  }
  return (
    <div class="flex flex-col gap-4">
      <StorageTopCard
        appId={appId}
        appName={appName}
        badge="DO"
        subtitle={`${doData.instances.length} instance(s)`}
        title={className}
      />
      {doData.instances.length === 0 ? (
        <p class="m-0 text-sm opacity-70">
          No instances yet — one is created the first time the object is called.
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
};

/** D1 database tables + first rows (picker/role/drawer in D1DetailPanel). */
const D1Detail = ({
  appId,
  databaseId,
}: {
  appId: string;
  databaseId: string;
}) => {
  const res = d1Preview(appId, databaseId);
  const loadError = res.error();
  if (loadError && res.data() === undefined) {
    return <p class="text-error m-0 text-sm">{String(loadError)}</p>;
  }
  const d1Data = res.data();
  if (!d1Data) {
    return <SectionSkeleton lines={5} />;
  }
  return (
    <D1DetailPanel
      appId={appId}
      databaseId={databaseId}
      d1Data={d1Data}
      onSaved={() => {
        void res.refetch();
      }}
    />
  );
};

/** One storage resource's details, dispatched on the resource-id prefix. */
export const StorageDetail = ({
  appId,
  resourceId,
}: {
  appId: string;
  resourceId: string;
}) => {
  const detail = appDetail(appId);
  const appName = detail.data()?.app.name ?? "";
  if (resourceId.startsWith("r2:")) {
    return (
      <R2Detail appId={appId} appName={appName} bucket={resourceId.slice(3)} />
    );
  }
  if (resourceId.startsWith("d1:")) {
    return <D1Detail appId={appId} databaseId={resourceId.slice(3)} />;
  }
  // DO resource ids are "do:{Binding}:{Name}" — the class is everything
  // after the binding, and either part may itself contain a colon.
  const className = resourceId.startsWith("do:")
    ? resourceId.split(":").slice(2).join(":")
    : resourceId;
  return <DoDetail appId={appId} appName={appName} className={className} />;
};
