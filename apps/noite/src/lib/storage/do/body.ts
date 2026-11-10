//! What the DO viewer can say about one instance's `?read=1` response.
//!
//! `DoInstance.preview` is `string | null` on the wire (the runner sends the
//! handler's body, or null when it could not read the object). The list and
//! the detail panel used to collapse four different outcomes into one string
//! ("unavailable" for not-running *or* no handler *or* a failed probe) and
//! truncated the JSON at 80 characters mid-token so two different states
//! rendered identically. One decode yields one closed value; the panel and
//! the list both switch on it.
//!
//! `null` is deliberately *one* state ("the probe returned nothing"): celld
//! does not tell the UI why, so the UI must not claim a reason it cannot
//! know. The copy says what is true — the object did not report a preview.
//!
//! ```text
//! preview === null ──▶ Silent        (no probe body: not running, no handler, or a failure)
//! valid JSON object ──▶ Json{entries} (empty object is Json{entries: []})
//! any other body ─────▶ Text{body}    (pretty-printed when it parses as JSON)
//! ```

import { Data } from "effect";
import * as Schema from "effect/Schema";

/** An app's `?read=1` response is its own shape: parse it as a record at this
 * boundary and render it generically. */
const PreviewRecord = Schema.Record(Schema.String, Schema.Unknown);

export type DoBody = Data.TaggedEnum<{
  /** The instance reported no preview body. */
  Silent: Record<never, never>;
  /** A JSON object, one key/value row each. */
  Json: { readonly entries: readonly { key: string; value: string }[] };
  /** Anything else (a scalar, an array, non-JSON text), pretty-printed. */
  Text: { readonly body: string };
}>;

export const Body = Data.taggedEnum<DoBody>();

/** Decode one instance's preview body. */
export const doBodyOf = (preview: string | null): DoBody => {
  if (preview === null) {
    return Body.Silent();
  }

  let raw: unknown;

  try {
    raw = JSON.parse(preview);
  } catch {
    return Body.Text({ body: preview });
  }

  const decoded = Schema.decodeUnknownResult(PreviewRecord)(raw);

  if (decoded._tag === "Failure") {
    return Body.Text({ body: preview });
  }

  return Body.Json({
    entries: Object.entries(decoded.success).map(([key, value]) => ({
      key,
      value: JSON.stringify(value, null, 2) ?? String(value),
    })),
  });
};

/** The one-line summary the instance list shows (never truncated mid-token:
 * the row's title carries the whole body). */
export const doSummary = (body: DoBody): string => {
  switch (body._tag) {
    case "Silent": {
      return "no preview reported";
    }

    case "Json": {
      if (body.entries.length === 0) {
        return "{} (empty)";
      }

      return body.entries
        .map((entry) => `${entry.key}=${entry.value.replaceAll(/\s+/gu, " ")}`)
        .join(" · ");
    }

    default: {
      return body.body.replaceAll(/\s+/gu, " ").trim();
    }
  }
};
