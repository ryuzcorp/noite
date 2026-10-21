import { atom } from "ilha";

import { isInstanceAdmin } from "../account/admin-telemetry";
import { updateStatus } from "../resources";
import { X } from "../ui/icons";
import { shouldShowUpdateBanner } from "./decision";

/** localStorage key holding the dismissed release tag. */
export const UPDATE_DISMISSED_KEY = "noite.update.dismissed";

/** The docs page that tells an operator how to upgrade. */
export const UPGRADE_DOCS_URL =
  "https://noite.now/self-hosting/operations#updating";

/** The dismissed tag, if the browser remembered one. */
const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY);
  } catch {
    return null;
  }
};

/** Admin-only "a newer release exists" banner, fed by the page's normal
 * data loading (no EventSource). Dismissal is remembered per version. */
const UpdateBannerInner = () => {
  const status = updateStatus().data();
  const dismissed = atom<string | null>(readDismissed());
  const latest = status?.latest;

  if (
    !shouldShowUpdateBanner(status, true, dismissed()) ||
    latest === undefined ||
    latest === null
  ) {
    return null;
  }

  const dismiss = () => {
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, latest);
    } catch {
      // A browser that refuses storage just re-shows the banner next load.
    }

    dismissed.set(latest);
  };

  return (
    <div class="px-4 pt-3" role="status">
      <div class="alert alert-info alert-soft flex items-center gap-2 py-2 text-sm">
        <span class="min-w-0 flex-1">
          Noite <strong>{latest}</strong> is available (you run{" "}
          {status?.current ?? "unknown"})
          {status?.notesUrl ? (
            <>
              {" · "}
              <a
                class="link"
                href={status.notesUrl}
                target="_blank"
                rel="noopener"
              >
                Release notes
              </a>
            </>
          ) : null}{" "}
          ·{" "}
          <a
            class="link"
            href={UPGRADE_DOCS_URL}
            target="_blank"
            rel="noopener"
          >
            How to upgrade
          </a>
        </span>
        <button
          type="button"
          class="btn btn-sm btn-ghost btn-square shrink-0"
          aria-label={`Dismiss the ${latest} notice`}
          onclick={() => {
            dismiss();
          }}
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

/** The banner slot for the control shell: members (and logged-out visitors)
 * render nothing and open no request — the admin-gated status fetch lives
 * behind the admin gate. */
export const UpdateBanner = () =>
  isInstanceAdmin() ? <UpdateBannerInner /> : null;
