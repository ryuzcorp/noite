//! The R2 object browser (Supabase Storage → Files → bucket): a breadcrumb
//! header, then the folder view. Writes — upload and New folder — stream to
//! the UI's proxy route, which hands the body to the runner's `celld r2 put`,
//! so the stored record is exactly what a Worker's `env.BUCKET.put()` writes.

import { searchParam } from "../../search-param";
import { StorageBreadcrumb, Toaster, useToasts } from "../shared";
import { R2Folder } from "./browser";
import { r2Crumbs, toR2View } from "./state";
import type { R2View } from "./state";

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
