import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";
import { createMutationQueue } from "oxidejs/mutation-queue";
import { kebabCase } from "scule";

import { create } from "./apps.server";
import type { App } from "./collaborators";
import { applistUrl, decodeApps, feedKeys, liveFeed } from "./feeds";
import { ChevronRight } from "./icons";
import { ListSkeleton } from "./skeletons";

const queue = createMutationQueue();
const createQueued = queue.wrap(create, {
  idempotencyKey: ({ slug }) => `create:${slug}`,
});

// Letters, digits, plus hyphens: fold whitespace, drop other symbols,
// and trim edge hyphens so live slugs match the create/rename gate.
export const slugifyName = (value: string): string =>
  kebabCase(value.replaceAll(/\s+/gu, "-"))
    .replaceAll(/[^A-Za-z0-9-]+/gu, "")
    .replaceAll(/-{2,}/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);

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
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase() || "?";
};

/** Presence dot tone: running = green, error = red, sleeping (scale to
 * zero: healthy, parked until its next request) = neutral, rest = yellow. */
export const presenceTone = (status: string): string => {
  if (status === "running") {
    return "status-success";
  }
  if (status === "sleeping") {
    return "status-neutral";
  }
  if (status === "failed" || status === "error") {
    return "status-error";
  }
  return "status-warning";
};

/** Reachable host for a stored subdomain on the current page's network.
 * Stored subdomains anchor on the configured base (dev: slug.localhost).
 * When this UI is served from outside that family (dev-host LAN name/IP),
 * rebase the slug onto the current host so the link stays on this network.
 * Loopback forms and same-family hosts keep the stored value untouched. */
export const appHost = (subdomain: string): string => {
  const { hostname } = window.location;
  const host = hostname.toLowerCase();
  const dot = subdomain.indexOf(".");
  const base = dot === -1 ? "" : subdomain.slice(dot + 1).toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
  if (loopback || host === base || (base !== "" && host.endsWith(`.${base}`))) {
    return subdomain;
  }
  const slug = dot === -1 ? subdomain : subdomain.slice(0, dot);
  return `${slug}.${hostname}`;
};

/** Live-app URL on the current host (mirrors LiveAppStatus in app-detail).
 * Dev carries the port over http; prod (no port) links plain https. */
export const appUrl = (subdomain: string): string => {
  const { port } = window.location;
  const host = appHost(subdomain);
  return port ? `http://${host}:${port}` : `https://${host}`;
};

/** App list over SSE: skeleton until the first frame, then live updates —
 * no polling, and resubscribe is automatic on drop. */
export const AppsList = () => {
  const feed = liveFeed(feedKeys.apps, applistUrl(), decodeApps);
  const items = (): App[] => feed.latest() ?? [];
  const loaded = (): boolean =>
    feed.latest() !== undefined || feed.status() === "open";
  const retrying = (): boolean => feed.status() === "retrying";

  return (
    <>
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          App stream disconnected — retrying…
        </p>
      ) : null}

      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Your Apps</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
          <a href="/apps/new" class="btn btn-sm btn-neutral">
            New app
          </a>
        </li>
        {!loaded() && (
          <li class="px-4 pt-2 pb-4">
            <ListSkeleton rows={3} />
          </li>
        )}
        {loaded() && items().length === 0 && (
          <li class="px-4 pt-2 pb-4 text-sm">
            <span class="text-base-content/70">No apps yet. </span>
            <a href="/apps/new" class="link">
              Create one
            </a>
            <span class="text-base-content/70"> to get a git remote.</span>
          </li>
        )}
        {loaded() &&
          items().map((app) => (
            <li key={app.id} class="list-row">
              <div>
                <div class="avatar avatar-placeholder">
                  <div class="bg-neutral text-neutral-content w-10 rounded-full">
                    <span class="text-sm">{initials(app.name)}</span>
                  </div>
                  <span
                    class={`status ${presenceTone(app.status)} absolute right-0 bottom-0`}
                    title={app.status}
                  />
                </div>
              </div>
              <div>
                <div>
                  <a
                    href={`/apps/${app.id}`}
                    class="link link-hover block truncate text-lg font-semibold"
                  >
                    {app.name}
                  </a>
                </div>
                <div class="text-base-content/70 truncate text-xs">
                  <a
                    class="link"
                    href={appUrl(app.subdomain)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {app.subdomain}
                  </a>
                </div>
              </div>
              <a
                href={`/apps/${app.id}`}
                class="btn btn-sm btn-square btn-ghost shrink-0"
                aria-label={`Open ${app.name} details`}
              >
                <span class="inline-flex h-5 w-5 shrink-0">
                  <ChevronRight class="h-5 w-5" />
                </span>
              </a>
            </li>
          ))}
      </ul>
    </>
  );
};

/** Dedicated create-app form; SPA-navigates to the list on success (the
 * SSE stream picks the new row up live — no document reload, no FOUC). */
export const CreateAppForm = () => {
  const notice = atom<string | null>(null);
  const busy = atom(false);
  const name = atom("");
  const slug = atom("");
  const slugTouched = atom(false);

  watch(name, (value) => {
    if (!slugTouched()) {
      slug.set(slugifyName(value));
    }
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const trimmedName = name().trim();
    let nextSlug = slug().trim().toLowerCase();
    if (!nextSlug && trimmedName) {
      nextSlug = slugifyName(trimmedName);
    }
    if (!(trimmedName && nextSlug)) {
      notice.set("Name and slug are required");
      return;
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u.test(nextSlug)) {
      notice.set(
        "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit"
      );
      return;
    }
    try {
      busy.set(true);
      await createQueued({ name: trimmedName, slug: nextSlug });
      // SPA nav keeps CSS/DOM parsed; the apps SSE stream adds the new row.
      navigate("/apps");
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
          value={name()}
          oninput={(e) => {
            name.set(e.currentTarget.value);
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
          pattern="[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?"
          maxlength={48}
          title="Lowercase letters, digits, and hyphens, 1–48 chars, starting and ending with a letter or digit"
          value={slug()}
          oninput={(e) => {
            const { value } = e.currentTarget;
            slug.set(value);
            slugTouched.set(value.length > 0);
          }}
          required
        />
        <p class="label">Auto-generated from the name — edit to override.</p>
        <p class="validator-hint hidden">
          Lowercase letters, digits, and hyphens, 1–48 chars
        </p>
      </fieldset>

      <button
        type="submit"
        class="btn btn-sm btn-neutral w-full"
        disabled={busy()}
      >
        {busy() ? "Creating…" : "Create app"}
      </button>
    </form>
  );
};
