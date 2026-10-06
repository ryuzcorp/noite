//! URL state and pure helpers for the R2 browser: the view toggle, the
//! breadcrumb path into a folder, and the selection map the multi-select
//! bar reads. Everything here is free of DOM and store access so it can be
//! unit-tested (see ./state.test).

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

/** Flip one key in a selection map without mutating the caller's copy. */
export const toggledKey = (
  selection: ReadonlySet<string>,
  key: string,
  on: boolean
): Set<string> => {
  const next = new Set(selection);
  if (on) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
};
