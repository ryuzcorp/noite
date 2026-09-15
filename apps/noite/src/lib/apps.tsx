import * as Stream from "effect/Stream";
import { atom, unsafe } from "ilha";
import { createMutationQueue } from "oxidejs/mutation-queue";

import { create, list } from "./apps.server";
import { Breadcrumbs } from "./breadcrumbs";
import type { App } from "./db";

const toStreamError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const queue = createMutationQueue();
const createQueued = queue.wrap(create, {
  idempotencyKey: ({ slug }) => `create:${slug}`,
});

// Letters plus hyphens only: fold whitespace, drop digits/symbols, and trim
// edge hyphens so live slugs match the create/rename gate.
export const slugifyName = async (value: string): Promise<string> => {
  const { kebabCase } = await import("scule");
  return kebabCase(value.replaceAll(/\s+/gu, "-"))
    .replaceAll(/[^A-Za-z-]+/gu, "")
    .replaceAll(/-{2,}/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);
};

// Mirror the name into the slug while typing, until the user overrides it.
// Imperative DOM writes (not atoms) so re-renders never steal input focus.
// Touched/auto state lives on the slug element's dataset, surviving renders.
const syncSlug = async (value: string) => {
  const el = document.querySelector("#create-slug");
  if (!(el instanceof HTMLInputElement) || el.dataset.touched === "1") {
    return;
  }
  const seen = el.dataset.auto ?? "";
  const next = await slugifyName(value);
  if (el.dataset.touched === "1" || (el.dataset.auto ?? "") !== seen) {
    return;
  }
  el.value = next;
  el.dataset.auto = next;
};

/** Initials for the avatar placeholder: first letters of the first two
 * words ("My Service" → "MS", "test" → "T"). */
export const initials = (name: string): string => {
  const parts = name
    .trim()
    .split(/\s+/u)
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return "?";
  }
  const first = parts[0][0] ?? "";
  const second = parts.length > 1 ? (parts[1][0] ?? "") : "";
  return `${first}${second}`.toUpperCase() || "?";
};

/** Presence dot tone: running = green, error = red, rest = yellow. */
export const presenceTone = (status: string): string => {
  if (status === "running") {
    return "status-success";
  }
  if (status === "failed" || status === "error") {
    return "status-error";
  }
  return "status-warning";
};

/** Lucide chevron-right. Static trusted markup (no user input), so the
 * unsafe() path is appropriate — it parses in the SVG namespace, which
 * inline <svg> JSX can't reach under ilha's HTML-namespace mounting. */
const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/** Live-app URL on the current host (mirrors LiveAppStatus in app-detail).
 * Dev carries the port over http; prod (no port) links plain https. */
const appUrl = (subdomain: string): string => {
  const { port } = window.location;
  return port ? `http://${subdomain}:${port}` : `https://${subdomain}`;
};

/** App list — navigation only; start/stop/delete live in app details. */
export const AppsList = () => {
  const listError = atom("");

  return Stream.map(
    // oxide Stream.catch mirrors an Error channel, not a Promise — the promise lint rules are false positives here.
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/valid-params
    Stream.catch(Stream.fromAsyncIterable(list(), toStreamError), (cause) => {
      listError.set(cause instanceof Error ? cause.message : String(cause));
      // SAFETY: an empty app list is the correct fallback shape on load failure.
      return Stream.succeed([] as App[]);
    }),
    (items: App[]) => (
      <>
        {listError() ? (
          <p class="text-error m-0 text-sm">{listError()}</p>
        ) : null}

        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Breadcrumbs trail={[{ label: "Apps" }]} />
            <span class="badge badge-primary">{items.length}</span>
          </div>
          <a href="/apps/new" class="btn btn-sm btn-primary">
            New app
          </a>
        </div>

        {items.length === 0 ? (
          <p class="text-base-content/70 m-0">
            No apps yet.{" "}
            <a href="/apps/new" class="link">
              Create one
            </a>{" "}
            to get a git remote.
          </p>
        ) : (
          <div class="flex w-full flex-col gap-4">
            {items.map((app) => (
              <div key={app.id} class="card bg-base-100 w-full shadow-sm">
                <div class="card-body gap-3">
                  <div class="flex items-center gap-3">
                    <div class="avatar avatar-placeholder shrink-0">
                      <div class="bg-neutral text-neutral-content w-12 rounded-full">
                        <span class="text-sm">{initials(app.name)}</span>
                      </div>
                      <span
                        class={`status ${presenceTone(app.status)} absolute right-0 bottom-0`}
                        title={app.status}
                      />
                    </div>
                    <div class="min-w-0 flex-1">
                      <a
                        href={`/apps/${app.id}`}
                        class="link link-hover card-title m-0 block truncate"
                      >
                        {app.name}
                      </a>
                      <p class="text-base-content/70 m-0 truncate text-sm">
                        <a
                          class="link"
                          href={appUrl(app.subdomain)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {app.subdomain}
                        </a>
                      </p>
                    </div>
                    <a
                      href={`/apps/${app.id}`}
                      class="btn btn-ghost btn-sm btn-circle shrink-0"
                      aria-label={`Open ${app.name} details`}
                    >
                      <span class="inline-flex h-5 w-5 shrink-0">
                        {unsafe(CHEVRON_SVG)}
                      </span>
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    )
  );
};

/** Dedicated create-app form; navigates to the new app's detail on success. */
export const CreateAppForm = () => {
  const notice = atom<string | null>(null);
  const busy = atom(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    let slug = String(data.get("slug") ?? "")
      .trim()
      .toLowerCase();
    if (!slug && name) {
      slug = await slugifyName(name);
    }
    if (!(name && slug)) {
      notice.set("Name and slug are required");
      return;
    }
    if (!/^[a-z](?:[a-z-]{0,46}[a-z])?$/u.test(slug)) {
      notice.set(
        "Slug must be 1–48 chars: lowercase letters and hyphens, starting and ending with a letter"
      );
      return;
    }
    try {
      busy.set(true);
      await createQueued({ name, slug });
      // The new DB id lives server-side; land on the list so the app shows up.
      window.location.replace("/apps");
    } catch (error) {
      busy.set(false);
      notice.set(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <form onsubmit={submit} class="flex flex-col gap-4">
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      <fieldset class="fieldset">
        <label class="label" for="create-name">
          Name
        </label>
        <input
          id="create-name"
          name="name"
          class="input w-full"
          placeholder="My Service"
          oninput={(e) => {
            const target = e.currentTarget;
            if (target instanceof HTMLInputElement) {
              void syncSlug(target.value);
            }
          }}
          autofocus
          required
        />
      </fieldset>
      <fieldset class="fieldset">
        <label class="label" for="create-slug">
          Slug
        </label>
        <input
          id="create-slug"
          name="slug"
          class="input validator w-full"
          placeholder="my-app"
          pattern="[a-z]([a-z-]{0,46}[a-z])?"
          maxlength={48}
          title="Lowercase letters and hyphens, 1–48 chars, starting and ending with a letter"
          oninput={(e) => {
            const target = e.currentTarget;
            if (target instanceof HTMLInputElement) {
              target.dataset.touched = target.value.length > 0 ? "1" : "";
            }
          }}
          required
        />
        <p class="label">Auto-generated from the name — edit to override.</p>
        <p class="validator-hint hidden">
          Lowercase letters and hyphens, 1–48 chars
        </p>
      </fieldset>

      <button type="submit" class="btn btn-primary w-full" disabled={busy()}>
        {busy() ? "Creating…" : "Create app"}
      </button>
    </form>
  );
};
