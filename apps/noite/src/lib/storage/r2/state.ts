//! URL state and pure helpers for the R2 browser: the view toggle, the
//! breadcrumb path into a folder, and the new-folder name. Everything here is
//! free of DOM and store access so it can be unit-tested (see ./state.test).
//! The cursor stack and the selection live in ./folder.

import { Data } from "effect";

import type { Crumb } from "../shared";

export const R2_VIEWS = ["list", "columns"] as const;

export type R2View = (typeof R2_VIEWS)[number];

export const R2_VIEW_LABELS: Record<R2View, string> = {
  columns: "Columns",
  list: "List",
};

export const toR2View = (raw: string): R2View =>
  raw === "columns" ? "columns" : "list";

/** The deep link to one folder of one bucket (`p` is the folder prefix). */
export const r2Href = (appId: string, bucket: string, prefix: string): string =>
  `/storage/${encodeURIComponent(appId)}/${encodeURIComponent(`r2:${bucket}`)}?p=${encodeURIComponent(prefix)}`;

/** The breadcrumb path into one folder: App › Buckets › bucket › segments. */
export const r2Crumbs = (
  appId: string,
  appName: string,
  bucket: string,
  prefix: string
): Crumb[] => {
  // A folder prefix always ends in `/`, so its parts are everything before
  // that last slash (an empty segment stays visible as "(empty)").
  const parts = prefix === "" ? [] : prefix.split("/").slice(0, -1);

  const crumbs: Crumb[] = [
    { href: `/apps/${appId}`, label: appName || "App" },
    { label: "Buckets" },
    {
      href: parts.length > 0 ? r2Href(appId, bucket, "") : undefined,
      label: bucket,
    },
  ];

  for (const [index, part] of parts.entries()) {
    crumbs.push({
      href:
        index === parts.length - 1
          ? undefined
          : r2Href(appId, bucket, `${parts.slice(0, index + 1).join("/")}/`),
      label: part === "" ? "(empty)" : part,
    });
  }

  return crumbs;
};

/** The new-folder form's name, as one value: empty, refused, or valid.
 * The old popover derived three booleans from one string and reported only
 * `/`, `..` and `.`, so an all-whitespace name disabled Create with no
 * explanation. */
export type FolderName = Data.TaggedEnum<{
  Empty: Record<never, never>;
  Invalid: { readonly reason: string };
  Valid: { readonly name: string };
}>;

export const FolderNameState = Data.taggedEnum<FolderName>();

/** Classify a typed folder name (trimmed; the stored marker uses the
 * trimmed form). */
export const folderNameOf = (raw: string): FolderName => {
  const name = raw.trim();

  if (name === "") {
    return FolderNameState.Empty();
  }

  if (name.includes("/")) {
    return FolderNameState.Invalid({
      reason: "A folder name cannot contain “/”.",
    });
  }

  if (name === "." || name === "..") {
    return FolderNameState.Invalid({ reason: "Pick a real folder name." });
  }

  return FolderNameState.Valid({ name });
};
