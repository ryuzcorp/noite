//! Shared chrome for the storage views (D1 editor, R2 browser, DO viewer):
//! toasts, the breadcrumb header, empty states, copy buttons, byte and
//! media-type formatting. D1 and R2/DO look like one product because they
//! render these pieces, not three near-copies of them.

import { atom } from "ilha";
import type { View } from "ilha";

import { Check, ChevronRight, Copy } from "../icons";

/** One transient confirmation (top-right, auto-hides). */
export interface Toast {
  id: number;
  text: string;
}

/** Toast state for one panel; `notify` shows a message for four seconds. */
export const useToasts = () => {
  const toasts = atom<Toast[]>([]);
  const ids = atom.lazy(() => ({ n: 0 }))();
  const notify = (text: string) => {
    ids.n += 1;
    const id = ids.n;
    toasts.set([...toasts(), { id, text }]);
    window.setTimeout(() => {
      toasts.set(toasts().filter((toast) => toast.id !== id));
    }, 4000);
  };
  return { notify, toasts };
};

export const Toaster = ({ toasts }: { toasts: Toast[] }) => (
  <div class="toast toast-top toast-end z-[100]">
    {toasts.map((toast) => (
      <div key={String(toast.id)} class="alert alert-success alert-soft">
        {toast.text}
      </div>
    ))}
  </div>
);

/** One breadcrumb step: a link when it leads somewhere, text when it is the
 * page the viewer is on. */
export interface Crumb {
  href?: string;
  label: string;
}

export const StorageBreadcrumb = ({ crumbs }: { crumbs: Crumb[] }) => (
  <nav aria-label="Breadcrumb" class="min-w-0">
    <ol class="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-sm">
      {crumbs.map((crumb, index) => (
        <li
          key={`${crumb.label}:${index}`}
          class="flex min-w-0 items-center gap-1"
        >
          {index > 0 ? (
            <ChevronRight class="h-3.5 w-3.5 shrink-0 opacity-50" />
          ) : null}
          {crumb.href === undefined ? (
            <span class="truncate font-medium" aria-current="page">
              {crumb.label}
            </span>
          ) : (
            <a class="link link-hover truncate opacity-70" href={crumb.href}>
              {crumb.label}
            </a>
          )}
        </li>
      ))}
    </ol>
  </nav>
);

/** The right-hand detail column shared by the R2 and DO views: a titled
 * panel that sits beside the list on wide screens and stacks below it on
 * narrow ones. */
export const DetailPanel = ({
  children,
  title,
}: {
  children: View;
  title: string;
}) => (
  <aside
    aria-label="Details"
    class="bg-base-100 dark:bg-base-200 border-base-300 flex w-full shrink-0 flex-col overflow-y-auto border-t lg:w-96 lg:border-t-0 lg:border-l"
  >
    <div class="border-base-300 border-b px-4 py-3">
      <h2 class="m-0 truncate text-sm font-semibold" title={title}>
        {title}
      </h2>
    </div>
    <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">{children}</div>
  </aside>
);

/** The empty-list body: what is missing, why, and how to fill it. */
export const EmptyState = ({
  action,
  hint,
  title,
}: {
  action?: View;
  hint: string;
  title: string;
}) => (
  <div class="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
    <p class="m-0 font-medium">{title}</p>
    <p class="m-0 max-w-md text-sm opacity-60">{hint}</p>
    {action}
  </div>
);

/** Copy one value to the clipboard, confirming in place for a moment. */
export const CopyButton = ({
  label,
  value,
}: {
  label: string;
  value: string;
}) => {
  const copied = atom(false);
  return (
    <button
      type="button"
      class="btn btn-sm btn-ghost gap-1"
      aria-label={label}
      onclick={() => {
        void navigator.clipboard?.writeText(value);
        copied.set(true);
        window.setTimeout(() => {
          copied.set(false);
        }, 1200);
      }}
    >
      {copied() ? <Check class="h-3.5 w-3.5" /> : <Copy class="h-3.5 w-3.5" />}
      {copied() ? "Copied" : "Copy"}
    </button>
  );
};

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human size for a listing or detail row (1024-based, one decimal below 10). */
export const formatBytes = (bytes: number): string => {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
};

/** What the R2 detail panel can show for one object. */
export type PreviewKind = "image" | "text" | "binary";

export const previewKind = (contentType: string | null): PreviewKind => {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) {
    return "image";
  }
  if (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml")
  ) {
    return "text";
  }
  return "binary";
};

/** Pretty-print a JSON body for a preview; non-JSON text is left as it is. */
export const prettyJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
