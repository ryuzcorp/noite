//! Shared chrome for the storage views (D1 editor, R2 browser, DO viewer):
//! toasts, the breadcrumb header, empty states, byte and media-type
//! formatting. D1 and R2/DO look like one product because they render these
//! pieces, not three near-copies of them.

import { Link } from "@ilha/void";
import { atom, watch } from "ilha";
import type { View } from "ilha";

import { ChevronRight } from "../ui/icons";
import { nextToasts, scheduleExpiry } from "./toast";
import type { Toast } from "./toast";

/** Toast state for one panel: a bounded queue (see `MAX_TOASTS`), where an
 * identical consecutive message refreshes the shown toast instead of
 * stacking, and unmount clears every timer. */
export const useToasts = () => {
  const toasts = atom<Toast[]>([]);
  const ids = atom.lazy(() => ({ n: 0 }))();
  const timers = atom.lazy(() => new Map<number, number>())();

  watch.once(() => () => {
    for (const timer of timers.values()) {
      window.clearTimeout(timer);
    }

    timers.clear();
  });

  const notify = (text: string) => {
    const last = toasts().at(-1);

    if (last?.text === text) {
      scheduleExpiry(
        timers,
        last.id,
        () => toasts(),
        (next) => {
          toasts.set(next);
        }
      );

      return;
    }

    ids.n += 1;
    const id = ids.n;
    toasts.set(nextToasts(toasts(), { id, text }));
    scheduleExpiry(
      timers,
      id,
      () => toasts(),
      (next) => {
        toasts.set(next);
      }
    );
  };

  return { notify, toasts };
};

/** The page's toast region, announced politely so a screen reader hears the
 * confirmation that a delete or an upload happened. */
export const Toaster = ({ toasts }: { toasts: readonly Toast[] }) => (
  <div
    class="toast toast-top toast-end z-[100]"
    role="status"
    aria-live="polite"
  >
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
            <Link class="link link-hover truncate opacity-70" href={crumb.href}>
              {crumb.label}
            </Link>
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

/** Human sizes in the storage views come from the source uploads' formatter
 * (one spelling of `12 KB` everywhere); re-exported so the views keep one
 * import. */

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
