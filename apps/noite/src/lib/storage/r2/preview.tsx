//! R2 object preview: bounded text/JSON body from the runner's preview route.

import { errorMessage } from "../../errors";
import { r2File } from "../../resources";
import type { R2Object } from "../../runner";
import { prettyJson } from "../shared";

/** Bounded text/JSON preview of one object (the runner sends at most 256 KiB
 * and null for a binary body). Keyed by the object key in the panel, so the
 * resource stays bound to one file for the life of the fiber. */
export const R2TextPreview = ({
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
