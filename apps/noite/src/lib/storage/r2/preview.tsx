//! R2 object preview: bounded text/JSON body from the runner's preview route.
//!
//! The body is one value (./body): loading, JSON, text, no text, or a reload
//! failure that keeps the last good body visible. Keyed by the object key in
//! the panel, so the resource stays bound to one file for the life of the
//! fiber.

import type { View } from "ilha";

import { r2File } from "../../resources";
import type { R2Object } from "../../runner";
import { prettyJson } from "../shared";
import { bodyText, r2BodyOf } from "./body";

export const R2TextPreview = ({
  appId,
  bucket,
  object,
}: {
  appId: string;
  bucket: string;
  object: R2Object;
}) => {
  const { body, notice } = r2BodyOf(
    r2File(appId, bucket, object.key).state(),
    object
  );

  const text = bodyText(body);

  let placeholder: View = null;

  if (body._tag === "Loading") {
    placeholder = <span class="skeleton h-24 w-full" />;
  } else if (body._tag === "NotText") {
    placeholder = (
      <p class="m-0 text-sm opacity-60">
        This object is not UTF-8 text, so there is nothing to preview.
      </p>
    );
  }

  let truncated: View = null;

  if (body._tag === "Json" || body._tag === "Text") {
    truncated = body.truncated ? (
      <p class="m-0 text-xs opacity-60">
        Preview truncated — download the file for the whole body.
      </p>
    ) : null;
  }

  return (
    <div class="flex flex-col gap-1">
      {notice === null ? null : (
        <p class="text-error m-0 text-xs" role="alert">
          {notice}
        </p>
      )}
      {placeholder}
      {text === null ? null : (
        <pre class="bg-base-200 dark:bg-base-300/50 m-0 max-h-64 overflow-auto rounded-lg p-2 text-xs whitespace-pre-wrap">
          {body._tag === "Json" ? prettyJson(text) : text}
        </pre>
      )}
      {truncated}
    </div>
  );
};
