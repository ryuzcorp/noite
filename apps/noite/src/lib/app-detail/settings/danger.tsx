//! Settings panel: the two destructive app actions (change slug, delete).

import { navigate } from "@ilha/router";
import { atom } from "ilha";
import type { View } from "ilha";

import { appHost } from "../../apps/identity";
import { errorMessage } from "../../errors";
import { dropAppFromSnapshot } from "../../feeds";
import { remove, renameApp } from "../../server/apps.server";
import { Dialog } from "../../ui/dialog";
import { SettingsSection } from "./section";

const MODAL_RESERVED_SLUGS = {
  _control: true,
  api: true,
  app: true,
  git: true,
};

/** Live slug validation message (null = valid), mirroring the runner gate. */
const slugValidationMessage = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) {
    return "Slug is required";
  }
  if (value.length > 48) {
    return "Max 48 characters";
  }
  if (/[A-Z]/u.test(value)) {
    return "Lowercase letters only";
  }
  if (/[^a-z0-9-]/u.test(value)) {
    return "Only lowercase letters, digits, and hyphens";
  }
  if (value.startsWith("-") || value.endsWith("-")) {
    return "Must start and end with a letter or digit";
  }
  if (value in MODAL_RESERVED_SLUGS) {
    return "Slug is reserved";
  }
  return null;
};

/** One Danger Zone row: what it does, and the button that does it. */
const DangerRow = ({
  action,
  children,
  title,
}: {
  action: View;
  children: View;
  title: string;
}) => (
  <div class="border-base-300 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-4 first:border-t-0 first:pt-0">
    <div class="min-w-0">
      <p class="m-0 text-sm font-medium">{title}</p>
      <p class="m-0 text-sm opacity-80">{children}</p>
    </div>
    <div class="shrink-0">{action}</div>
  </div>
);

/** Danger Zone (admins only): the two actions that cannot be taken back
 * quietly. Changing the slug moves the app's URL and git remote behind an
 * explicit risk dialog; deleting removes the app. */
export const AppDangerZone = ({
  appId,
  name,
  onSaved,
  slug,
}: {
  appId: string;
  name: string;
  onSaved: () => void;
  slug: string;
}) => {
  const dialogOpen = atom(false);
  const slugDraft = atom(slug);
  const slugErr = atom("");
  const busy = atom(false);
  const notice = atom<string | null>(null);
  const slugError = (): string | null => slugValidationMessage(slugDraft());

  const saveSlug = async () => {
    if (busy()) {
      return;
    }
    const raw = slugDraft();
    if (slugValidationMessage(raw)) {
      return;
    }
    busy.set(true);
    try {
      await renameApp({ id: appId, slug: raw.trim().toLowerCase() });
      slugErr.set("");
      dialogOpen.set(false);
      onSaved();
    } catch (error) {
      slugErr.set(errorMessage(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <SettingsSection>
      <h3 class="text-error m-0 text-lg font-semibold">Danger Zone</h3>
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}
      <DangerRow
        title="Change slug"
        action={
          <button
            type="button"
            class="btn btn-sm btn-warning"
            disabled={busy()}
            onclick={() => {
              slugErr.set("");
              slugDraft.set(slug);
              dialogOpen.set(true);
            }}
          >
            Change slug
          </button>
        }
      >
        The slug is <code class="font-mono">{slug}</code>. Changing it moves the
        app URL and the git remote.
      </DangerRow>
      <DangerRow
        title="Delete app"
        action={
          <button
            type="button"
            class="btn btn-sm btn-error"
            onclick={async () => {
              if (
                // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
                !window.confirm(
                  `Delete ${name}? This removes the app, its git remote and its fleet.`
                )
              ) {
                return;
              }
              try {
                await remove(appId);
                dropAppFromSnapshot(appId);
                navigate("/apps");
              } catch (error) {
                notice.set(errorMessage(error));
              }
            }}
          >
            Delete App
          </button>
        }
      >
        Removes the app, its git remote and its fleet. This cannot be undone.
      </DangerRow>
      <Dialog open={dialogOpen} class="modal">
        <div class="modal-box bg-base-100 dark:bg-base-200">
          <h3 class="m-0 text-lg font-bold">Change slug?</h3>
          <p class="m-0 py-2 text-sm opacity-80">
            This renames the app everywhere: the app URL becomes{" "}
            <code id="slug-preview">
              {appHost(
                `${slugDraft().trim().toLowerCase() || "\u2026"}.localhost`
              )}
            </code>{" "}
            and the git origin moves to the new slug — update your local remote
            (`git remote set-url`) and any bookmarks. The fleet keeps running;
            deploys are blocked while the move completes.
          </p>
          <fieldset class="fieldset w-full">
            <label class="label" for="slug-input">
              New slug
            </label>
            <input
              id="slug-input"
              class="input input-sm validator font-mono"
              disabled={busy()}
              placeholder="my-app"
              pattern="[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?"
              maxlength={48}
              title="Lowercase letters, digits, and hyphens, 1–48 chars, starting and ending with a letter or digit"
              value={slugDraft()}
              oninput={(e) => {
                slugDraft.set(e.currentTarget.value);
              }}
            />
          </fieldset>
          <p id="slug-error" class="text-error m-0 text-sm">
            {slugError() ?? slugErr()}
          </p>
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={busy()}
              onclick={() => dialogOpen.set(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-sm btn-warning"
              disabled={busy() || slugError() !== null}
              onclick={() => {
                void saveSlug();
              }}
            >
              {busy() ? "Moving…" : "Move app"}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button aria-label="Close dialog" disabled={busy()}>
            close
          </button>
        </form>
      </Dialog>
    </SettingsSection>
  );
};
