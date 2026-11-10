//! What the R2 detail panel paints for one object: the preview kind decides
//! *how*, this machine decides *what*, from the resource state.
//!
//! `data.text === null` meant two different things (a binary body, or an
//! empty file) and the JSON detection read two different content types, so
//! the same object could render pretty or raw depending on which resource was
//! warm. One decode from the resource state makes the body one value.
//!
//! ```text
//! Loading ──▶ Ready{text}  →  Json | Text      (truncated when the runner capped it)
//!                         →  NotText           (binary or empty)
//!         └─▶ Failed{message}  (keeping the last body when there is one)
//! ```

import { Data } from "effect";

import { errorMessage } from "../../errors";
import type { ResourceState } from "../../resource";
import { resourceError, resourceValue } from "../../resource";
import type { R2File, R2Object } from "../../runner";

export type R2Body = Data.TaggedEnum<{
  /** No body loaded yet. */
  Loading: Record<never, never>;
  /** A JSON body (pretty-printed). */
  Json: { readonly text: string; readonly truncated: boolean };
  /** Plain text. */
  Text: { readonly text: string; readonly truncated: boolean };
  /** No text to show: a binary body, or an empty file. */
  NotText: Record<never, never>;
}>;

export const Body = Data.taggedEnum<R2Body>();

/** Whether a content type is JSON (one place, so the object's metadata and
 * the fetched body agree). */
const isJsonType = (contentType: string | null): boolean =>
  (contentType ?? "").toLowerCase().includes("json");

/** The preview panel's whole paint: the body, plus the reload failure when
 * the last refresh failed (the last good body stays visible). */
export interface R2PreviewView {
  readonly body: R2Body;
  readonly notice: string | null;
}

/** The body the panel paints for the current resource state. */
export const r2BodyOf = (
  state: ResourceState<R2File>,
  object: R2Object
): R2PreviewView => {
  const data = resourceValue(state);
  const error = resourceError(state);
  const notice = error === undefined ? null : errorMessage(error);

  if (data === undefined) {
    return { body: Body.Loading(), notice };
  }

  if (data.text === null) {
    return { body: Body.NotText(), notice };
  }

  const json = isJsonType(object.contentType) || isJsonType(data.contentType);

  return {
    body: json
      ? Body.Json({ text: data.text, truncated: data.truncated })
      : Body.Text({ text: data.text, truncated: data.truncated }),
    notice,
  };
};

/** The text a JSON body should pretty-print (the caller passes it through
 * `prettyJson`, which leaves invalid JSON alone). */
export const bodyText = (body: R2Body): string | null => {
  switch (body._tag) {
    case "Json":
    case "Text": {
      return body.text;
    }

    default: {
      return null;
    }
  }
};
