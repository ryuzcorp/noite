//! The create page's form: pick what the new app starts as — an empty repo, a
//! public GitHub repo (A2), or a shipped template (A3) — then Name and Slug.
//! Laid out as labelled rows (label left, control right) in one card with a
//! Cancel / Create footer; the Slug row checks the slug while you type and
//! shows the URL and git remote it would get.

import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";
import type { View } from "ilha";
import { createMutationQueue } from "oxidejs/mutation-queue";

import { formatBytes } from "../bytes";
import { commitSource } from "../commit-source";
import { errorMessage } from "../errors";
import { create, slugCheck } from "../server/apps.server";
import type { SlugCheck } from "../server/apps.server";
import { readDroppedItems } from "../source/uploads";
import {
  ArrowUpRight,
  Check,
  Folder,
  Github,
  LayoutTemplate,
  Plus,
} from "../ui/icons";
import type { CreateSourceInput, GitHubRepo } from "./create-source";
import { parseGitHubRepo } from "./create-source";
import { projectSkip, projectUpload } from "./folder-drop";
import type { ProjectUpload } from "./folder-drop";
import { appUrl, slugifyName } from "./identity";
import { TEMPLATES } from "./templates";

// Same queue the old form used: a double submit for one slug creates one app.
const queue = createMutationQueue();
const createQueued = queue.wrap(create, {
  idempotencyKey: ({ slug }) => `create:${slug}`,
});

const MODES = [
  {
    hint: "An empty repository. Push when you're ready.",
    icon: Plus,
    id: "blank",
    label: "Blank",
  },
  {
    hint: "A one-time copy of a public repo, history included.",
    icon: Github,
    id: "import",
    label: "Import from GitHub",
  },
  {
    hint: "A starter project, as one initial commit.",
    icon: LayoutTemplate,
    id: "template",
    label: "Template",
  },
] as const;

type ModeId = (typeof MODES)[number]["id"];

/** Where the Slug field's value came from: it follows the name until a pick
 * (template, repo URL) or the user's own typing takes it over. */
type SlugOrigin = "folder" | "name" | "repo" | "template" | "user";

const SLUG_ORIGIN_HINT: Record<SlugOrigin, string> = {
  folder: "Taken from the folder name. Edit to override.",
  name: "Generated from the name. Edit to override.",
  repo: "Taken from the repository or folder name. Edit to override.",
  template: "Taken from the template. Edit to override.",
  user: "Lowercase letters, digits and hyphens, up to 48 characters.",
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;
const SLUG_HINT =
  "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit";

/** Typing settles this long before the slug is checked against the server. */
const SLUG_CHECK_DEBOUNCE_MS = 300;

/** The Slug row's live verdict, for the slug it was computed for. */
type SlugState =
  | { slug: string; status: "checking" | "idle" }
  | { result: SlugCheck; slug: string; status: "done" };

/** One labelled row of the card: label (and an optional note) on the left,
 * the control on the right; stacked on narrow screens. */
const Row = ({
  children,
  htmlFor,
  label,
  note,
}: {
  children: View;
  htmlFor?: string;
  label: string;
  note?: string;
}) => (
  <div class="border-base-300 grid grid-cols-1 gap-x-8 gap-y-2 border-t px-6 py-5 md:grid-cols-[11rem_minmax(0,1fr)]">
    <div class="flex flex-col gap-1 pt-1.5">
      {htmlFor ? (
        <label class="text-sm font-medium" for={htmlFor}>
          {label}
        </label>
      ) : (
        <span class="text-sm font-medium">{label}</span>
      )}
      {note ? <span class="text-base-content/60 text-xs">{note}</span> : null}
    </div>
    <div class="flex min-w-0 flex-col gap-2">{children}</div>
  </div>
);

/** Radio styled as a selectable card: the native `:checked` state drives the
 * border, so the selection never depends on a re-render rewriting classes.
 * The (invisible) input covers the whole card, so a click anywhere on it is a
 * click on the radio; a link inside sits above it (`CHOICE_ABOVE`). */
const CHOICE_CARD =
  "border-base-300 hover:border-base-content/30 has-checked:border-base-content has-checked:bg-base-200 dark:has-checked:bg-base-300 has-focus-visible:outline-base-content rounded-box relative flex gap-3 border p-3 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2";
const CHOICE_INPUT =
  "absolute inset-0 z-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0";
const CHOICE_ABOVE = "relative z-10";

/** The last folder of a repository path (`apps/web` → `web`). */
const folderName = (path: string): string =>
  path.trim().replaceAll(/\/+$/gu, "").split("/").at(-1) ?? "";

/** Under the URL: what will be imported (`owner/repo/folder@ref`), or what the
 * field takes. */
const ImportSummary = ({
  path,
  reference,
  repo,
}: {
  path: string;
  reference: string;
  repo: GitHubRepo | null;
}) => {
  if (!repo) {
    return (
      <span class="text-base-content/60 text-xs">
        A public repository on github.com, or a link to a folder in it.
      </span>
    );
  }
  const folder = path.trim().replaceAll(/^\/+|\/+$/gu, "");
  const branch = reference.trim();
  return (
    <span class="text-base-content/70 inline-flex items-center gap-1.5 text-xs">
      <Github class="h-3.5 w-3.5" />
      <span class="font-mono">
        {`${repo.owner}/${repo.repo}${folder ? `/${folder}` : ""}${branch ? `@${branch}` : ""}`}
      </span>
    </span>
  );
};

/** The import's optional refinements, folded away until wanted: which branch
 * or tag, and — for a monorepo — which folder becomes the app. */
const ImportOptions = ({
  onPath,
  onReference,
  path,
  reference,
}: {
  onPath: (value: string) => void;
  onReference: (value: string) => void;
  path: string;
  reference: string;
}) => (
  <details class="group" open={reference !== "" || path !== ""}>
    <summary class="text-base-content/70 hover:text-base-content cursor-pointer text-xs select-none">
      Branch, tag or folder (optional)
    </summary>
    <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label class="flex flex-col gap-1">
        <span class="text-base-content/70 text-xs">Branch or tag</span>
        <input
          id="create-ref"
          name="ref"
          class="input input-sm w-full"
          placeholder="Default branch"
          autocomplete="off"
          value={reference}
          oninput={(e) => {
            onReference(e.currentTarget.value);
          }}
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-base-content/70 text-xs">Folder (monorepo)</span>
        <input
          id="create-path"
          name="path"
          class="input input-sm w-full font-mono"
          placeholder="apps/web"
          autocomplete="off"
          spellcheck={false}
          value={path}
          oninput={(e) => {
            onPath(e.currentTarget.value);
          }}
        />
      </label>
    </div>
    <p class="text-base-content/60 mt-2 mb-0 text-xs">
      With a folder, only that folder is imported, as the app's root, in one
      commit without the repository's history.
    </p>
  </details>
);

/** What the picked mode asks the create action for, or why it cannot yet. */
const sourceFor = (
  mode: ModeId,
  fields: { path: string; ref: string; templateId: string; url: string }
): { error: string } | { source: CreateSourceInput } => {
  if (mode === "import") {
    const repo = parseGitHubRepo(fields.url);
    if (!repo) {
      return {
        error:
          "Enter a public GitHub repository URL, e.g. https://github.com/owner/repo",
      };
    }
    // The branch and folder stay out when their fields are empty: an
    // explicit `undefined` is not a JSON value, and the action's RPC encoder
    // refuses the whole call over it ("Expected JSON value at [args][0]").
    const branch = fields.ref.trim();
    const folder = fields.path.trim().replaceAll(/^\/+|\/+$/gu, "");
    const imported: Extract<CreateSourceInput, { kind: "git" }> = {
      kind: "git",
      url: `https://github.com/${repo.owner}/${repo.repo}`,
    };
    if (branch !== "") {
      imported.ref = branch;
    }
    if (folder !== "") {
      imported.path = folder;
    }
    return { source: imported };
  }
  if (mode === "template") {
    const picked = TEMPLATES.find((t) => t.id === fields.templateId);
    return picked
      ? { source: { id: picked.id, kind: "template" } }
      : { error: "Pick a template" };
  }
  return { source: { kind: "blank" } };
};

/** Under the Slug field: why it can't be used (with a free variant to take),
 * where it came from while it's being checked, and the URL and git remote it
 * gets once it's free. */
const SlugStatus = ({
  checking,
  hint,
  onUse,
  verdict,
}: {
  checking: boolean;
  hint: string;
  onUse: (suggestion: string) => void;
  verdict: SlugCheck | null;
}) => (
  <div
    id="create-slug-status"
    class="flex flex-col gap-1 text-xs"
    aria-live="polite"
  >
    {verdict?.error ? (
      <span class="text-error inline-flex flex-wrap items-center gap-2">
        {verdict.error}
        {verdict.suggestion ? (
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            onclick={() => {
              onUse(verdict.suggestion ?? "");
            }}
          >
            Use <span class="font-mono">{verdict.suggestion}</span>
          </button>
        ) : null}
      </span>
    ) : (
      <span class="text-base-content/60">{hint}</span>
    )}
    {checking ? (
      <span class="text-base-content/60">Checking availability…</span>
    ) : null}
    {verdict && !verdict.error ? (
      <dl class="bg-base-200 dark:bg-base-300 rounded-box m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2">
        <dt class="text-success inline-flex items-center gap-1">
          <Check class="h-3.5 w-3.5" />
          URL
        </dt>
        <dd class="m-0 truncate font-mono">{appUrl(verdict.host)}</dd>
        {verdict.gitRemote ? (
          <>
            <dt class="text-base-content/60 pl-[1.125rem]">Git</dt>
            <dd class="m-0 truncate font-mono">{verdict.gitRemote}</dd>
          </>
        ) : null}
      </dl>
    ) : null}
  </div>
);

/** The Start from row once a folder was dropped: what will be committed, and
 * the way back to the three modes. */
const FolderCard = ({
  folder,
  onRemove,
}: {
  folder: ProjectUpload;
  onRemove: () => void;
}) => (
  <div class="border-base-content bg-base-200 dark:bg-base-300 rounded-box flex items-center gap-3 border p-3">
    <Folder class="h-5 w-5 shrink-0" />
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="truncate text-sm font-medium">{folder.name}</span>
      <span class="text-base-content/60 text-xs">
        {folder.files.length} {folder.files.length === 1 ? "file" : "files"} ·{" "}
        {formatBytes(folder.bytes)} · committed to <code>main</code> as the
        first commit
      </span>
    </span>
    <button type="button" class="btn btn-ghost btn-xs" onclick={onRemove}>
      Remove
    </button>
  </div>
);

/** Whether a drag carries files from the OS (not a dragged link or text). */
const isFileDrag = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes("Files") ?? false;

/** `dragover` must be cancelled for a drop to land at all. */
const allowFileDrop = (event: DragEvent) => {
  if (isFileDrag(event)) {
    event.preventDefault();
  }
};

/** Full-page highlight while a folder is dragged over the creator, and while
 * a dropped one is read. */
const DropOverlay = ({ reading }: { reading: boolean }) => (
  <div
    class="bg-base-100/80 pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
    aria-hidden="true"
  >
    <div class="border-base-content/40 rounded-box flex h-full w-full flex-col items-center justify-center gap-2 border-2 border-dashed">
      <Folder class="h-8 w-8" />
      <span class="text-base font-medium">
        {reading ? "Reading folder…" : "Drop a folder to create an app"}
      </span>
      <span class="text-base-content/60 text-xs">
        Up to 100 files and 25 MB, committed to <code>main</code>.
      </span>
    </div>
  </div>
);

/** The creator's error line; `stranded` names an app that was created before
 * its upload failed, so the user can still reach it. */
const CreateNotice = ({
  message,
  stranded,
}: {
  message: string | null;
  stranded: string | null;
}) =>
  message ? (
    <div class="border-base-300 border-t px-6 py-3">
      <div class="alert alert-error m-0 py-2 text-sm" role="alert">
        <span>
          {message}
          {stranded ? (
            <>
              {" "}
              <a href={`/apps/${stranded}`} class="link">
                Open the app
              </a>
            </>
          ) : null}
        </span>
      </div>
    </div>
  ) : null;

export const CreateAppForm = () => {
  const notice = atom<string | null>(null);
  const busy = atom(false);
  const mode = atom<ModeId>("blank");
  const name = atom("");
  const slug = atom("");
  const url = atom("");
  const ref = atom("");
  /** Subdirectory of the repo to import (a monorepo package). */
  const subpath = atom("");
  const templateId = atom(TEMPLATES[0]?.id ?? "");
  const slugOrigin = atom<SlugOrigin>("name");
  const slugState = atom<SlugState>({ slug: "", status: "idle" });
  /** A dropped project folder: the new app starts blank and gets these files
   * as its first commit. */
  const folder = atom<ProjectUpload | null>(null);
  const dragging = atom(false);
  const reading = atom(false);
  /** An app created whose upload then failed: the notice links to it. */
  const stranded = atom<string | null>(null);
  /** Fill Name and Slug from a pick — a template, or the repo a URL names.
   * `priorName` is what the previous pick put in the field: a name the user
   * typed themselves is anything else, and it stays. Picking a second
   * template used to move the slug but leave the first one's name behind. */
  const applySource = (
    picked: { name?: string; slug: string },
    origin: "folder" | "repo" | "template",
    priorName = ""
  ) => {
    slugOrigin.set(origin);
    const current = name().trim();
    if (picked.name && (current === "" || current === priorName.trim())) {
      name.set(picked.name);
    }
    slug.set(picked.slug);
  };

  watch(name, (value) => {
    if (slugOrigin() === "name") {
      slug.set(slugifyName(value));
    }
  });

  /** Ask the server about `value` now; the answer only lands if the field
   * still holds it. */
  const checkNow = async (value: string): Promise<SlugCheck | null> => {
    slugState.set({ slug: value, status: "checking" });
    try {
      const result = await slugCheck({ slug: value });
      if (slug().trim().toLowerCase() === value) {
        slugState.set({ result, slug: value, status: "done" });
      }
      return result;
    } catch {
      // The check is advisory: create re-validates, so a failed check leaves
      // the row quiet rather than blocking the form.
      if (slug().trim().toLowerCase() === value) {
        slugState.set({ slug: value, status: "idle" });
      }
      return null;
    }
  };

  // Debounced: each new value (or unmount) clears the previous run's timer,
  // and `checkNow` drops an answer for a slug the field no longer holds.
  watch(slug, (raw, { onCleanup }) => {
    const value = raw.trim().toLowerCase();
    if (value === "" || !SLUG_RE.test(value)) {
      slugState.set({ slug: value, status: "idle" });
      return;
    }
    slugState.set({ slug: value, status: "checking" });
    const timer = window.setTimeout(() => {
      void checkNow(value);
    }, SLUG_CHECK_DEBOUNCE_MS);
    onCleanup(() => {
      window.clearTimeout(timer);
    });
  });

  /** Read a dropped folder into `folder` and name the app after it. Only one
   * folder is taken: a project has one root. */
  const dropFolder = async (items: DataTransferItemList) => {
    const entries = [...items].map((item) => item.webkitGetAsEntry?.() ?? null);
    const [root] = entries;
    if (entries.length !== 1 || !root?.isDirectory) {
      notice.set("Drop one folder: your project's root.");
      return;
    }
    notice.set(null);
    stranded.set(null);
    reading.set(true);
    const reads = await readDroppedItems(items, projectSkip);
    reading.set(false);
    const result = projectUpload(root.name, reads);
    if ("error" in result) {
      notice.set(result.error);
      return;
    }
    const previous = folder();
    folder.set(result.upload);
    mode.set("blank");
    applySource(
      { name: result.upload.name, slug: slugifyName(result.upload.name) },
      "folder",
      previous?.name ?? ""
    );
  };

  // The whole page is the drop zone, so the listeners sit on the document
  // for as long as the creator is mounted. `depth` counts nested
  // enter/leave pairs, which fire for every element the drag crosses.
  watch.once(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event)) {
        return;
      }
      event.preventDefault();
      depth += 1;
      dragging.set(true);
    };
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event)) {
        return;
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        dragging.set(false);
      }
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event)) {
        return;
      }
      event.preventDefault();
      depth = 0;
      dragging.set(false);
      const items = event.dataTransfer?.items;
      if (items && !busy()) {
        void dropFolder(items);
      }
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", allowFileDrop);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", allowFileDrop);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  });

  const pickMode = (next: ModeId) => {
    mode.set(next);
    notice.set(null);
    if (next === "blank") {
      // A blank app has no repo to take the slug from: let the name drive
      // it again, unless the user typed one.
      if (slugOrigin() !== "user") {
        slugOrigin.set("name");
        slug.set(slugifyName(name()));
      }
      return;
    }
    if (next === "template") {
      const picked = TEMPLATES.find((t) => t.id === templateId());
      if (picked) {
        applySource(
          { name: picked.name, slug: slugifyName(picked.id) },
          "template",
          picked.name
        );
      }
      return;
    }
    const repo = parseGitHubRepo(url());
    if (repo) {
      applySource({ name: repo.name, slug: repo.slug }, "repo", repo.name);
    }
    // The URL is the first thing an import needs: put the caret there once
    // the row is in the page.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("#create-url")?.focus();
    });
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    notice.set(null);
    const trimmedName = name().trim();
    let nextSlug = slug().trim().toLowerCase();
    if (!nextSlug && trimmedName) {
      nextSlug = slugifyName(trimmedName);
    }
    if (!(trimmedName && nextSlug)) {
      notice.set("Name and slug are required");
      return;
    }
    if (!SLUG_RE.test(nextSlug)) {
      notice.set(SLUG_HINT);
      return;
    }
    const state = slugState();
    if (
      state.status === "done" &&
      state.slug === nextSlug &&
      state.result.error
    ) {
      document.querySelector<HTMLElement>("#create-slug")?.focus();
      return;
    }
    const picked = sourceFor(mode(), {
      path: subpath(),
      ref: ref(),
      templateId: templateId(),
      url: url(),
    });
    if ("error" in picked) {
      notice.set(picked.error);
      return;
    }
    const { source } = picked;
    const upload = folder();
    busy.set(true);
    let createdId: string;
    try {
      ({ id: createdId } = await createQueued({
        name: trimmedName,
        slug: nextSlug,
        source: upload ? { kind: "blank" } : source,
      }));
    } catch (error) {
      busy.set(false);
      // A slug lost to a race (or reserved) belongs under the Slug field, not
      // in a banner quoting the runner: ask again and show it there.
      const recheck = await checkNow(nextSlug);
      if (recheck?.error) {
        document.querySelector<HTMLElement>("#create-slug")?.focus();
        return;
      }
      notice.set(errorMessage(error));
      return;
    }
    if (upload) {
      try {
        // The dropped folder lands as the first commit on `main`, which
        // deploys it like a push.
        await commitSource({
          appId: createdId,
          files: upload.files,
          message: `Upload ${upload.name}`,
        });
      } catch (error) {
        busy.set(false);
        stranded.set(createdId);
        notice.set(
          `The app was created, but the folder could not be committed: ${errorMessage(error)}`
        );
        return;
      }
    }
    // A blank app's next step is a push, which its Overview explains; an
    // upload, import or template is already building, which Deployments
    // shows.
    navigate(
      source.kind === "blank" && !upload
        ? `/apps/${createdId}`
        : `/apps/${createdId}?t=deployments`
    );
  };

  const state = slugState();
  const currentSlug = slug().trim().toLowerCase();
  const verdict =
    state.status === "done" && state.slug === currentSlug ? state.result : null;
  const repo = parseGitHubRepo(url());
  const dropped = folder();

  return (
    <div class="flex flex-col gap-3">
      <form
        onsubmit={submit}
        class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box overflow-hidden border shadow-sm"
        novalidate
      >
        <header class="flex flex-col gap-1 px-6 py-5">
          <h1 class="m-0 text-base font-semibold">Create a new app</h1>
          <p class="text-base-content/70 m-0 text-sm">
            Every app gets a git remote and its own URL. Each push to{" "}
            <code>main</code> deploys.
          </p>
        </header>

        <Row label="Start from">
          {dropped ? (
            <FolderCard
              folder={dropped}
              onRemove={() => {
                folder.set(null);
                if (slugOrigin() === "folder") {
                  slugOrigin.set("name");
                  slug.set(slugifyName(name()));
                }
              }}
            />
          ) : (
            <div
              role="radiogroup"
              aria-label="Start from"
              class="grid grid-cols-1 gap-2 sm:grid-cols-3"
            >
              {MODES.map((m) => (
                <label key={m.id} class={`${CHOICE_CARD} flex-col`}>
                  <input
                    type="radio"
                    name="source"
                    value={m.id}
                    class={CHOICE_INPUT}
                    checked={mode() === m.id}
                    onchange={() => {
                      pickMode(m.id);
                    }}
                  />
                  <m.icon class="h-4 w-4" />
                  <span class="flex flex-col gap-0.5">
                    <span class="text-sm font-medium">{m.label}</span>
                    <span class="text-base-content/60 text-xs leading-snug">
                      {m.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Row>

        {mode() === "import" ? (
          <Row
            htmlFor="create-url"
            label="Repository"
            note="Copied once. Noite's repo becomes the source of truth."
          >
            <input
              id="create-url"
              name="url"
              type="url"
              class="input w-full"
              placeholder="https://github.com/owner/repo"
              autocomplete="off"
              value={url()}
              oninput={(e) => {
                const previous = parseGitHubRepo(url());
                url.set(e.currentTarget.value);
                const parsed = parseGitHubRepo(e.currentTarget.value);
                if (parsed) {
                  // A pasted folder link fills the branch and folder too.
                  if (parsed.ref !== undefined) {
                    ref.set(parsed.ref);
                    subpath.set(parsed.path ?? "");
                  }
                  applySource(
                    { name: parsed.name, slug: parsed.slug },
                    "repo",
                    previous?.name ?? ""
                  );
                }
              }}
              required
            />
            <ImportSummary path={subpath()} reference={ref()} repo={repo} />
            <ImportOptions
              path={subpath()}
              reference={ref()}
              onPath={(value) => {
                const previous = folderName(subpath());
                subpath.set(value);
                const named = folderName(value) || repo?.name || "";
                // A folder names the app, like a repo does, until the user
                // types a name or slug of their own.
                if (slugOrigin() === "repo" && repo) {
                  applySource(
                    { name: named, slug: slugifyName(named) },
                    "repo",
                    previous || repo.name
                  );
                }
              }}
              onReference={(value) => {
                ref.set(value);
              }}
            />
          </Row>
        ) : null}

        {mode() === "template" ? (
          <Row label="Template">
            <div
              role="radiogroup"
              aria-label="Template"
              class="flex flex-col gap-2"
            >
              {TEMPLATES.map((t) => (
                <label key={t.id} class={`${CHOICE_CARD} items-start`}>
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    class={CHOICE_INPUT}
                    checked={templateId() === t.id}
                    onchange={() => {
                      const previous = TEMPLATES.find(
                        (template) => template.id === templateId()
                      );
                      templateId.set(t.id);
                      applySource(
                        { name: t.name, slug: slugifyName(t.id) },
                        "template",
                        previous?.name ?? ""
                      );
                    }}
                  />
                  <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="text-sm font-medium">{t.name}</span>
                    <span class="text-base-content/60 text-xs">
                      {t.description}
                    </span>
                    <span class="mt-1 flex flex-wrap gap-1">
                      {t.stack.map((tag) => (
                        <span key={tag} class="badge badge-ghost badge-sm">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </span>
                  <a
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class={`${CHOICE_ABOVE} link link-hover text-base-content/60 inline-flex shrink-0 items-center gap-0.5 text-xs`}
                    aria-label={`${t.name} source on GitHub`}
                    onclick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    Source
                    <ArrowUpRight class="h-3 w-3" />
                  </a>
                </label>
              ))}
            </div>
          </Row>
        ) : null}

        <Row htmlFor="create-name" label="Name" note="Shown in the dashboard.">
          <input
            id="create-name"
            name="name"
            class="input w-full"
            placeholder="My Service"
            autocomplete="off"
            value={name()}
            oninput={(e) => {
              name.set(e.currentTarget.value);
            }}
            autofocus
            required
          />
        </Row>

        <Row
          htmlFor="create-slug"
          label="Slug"
          note="The app's URL and git remote."
        >
          <input
            id="create-slug"
            name="slug"
            class={`input w-full font-mono ${verdict?.error ? "input-error" : ""}`}
            placeholder="my-app"
            maxlength={48}
            autocomplete="off"
            spellcheck={false}
            aria-invalid={verdict?.error ? "true" : "false"}
            aria-describedby="create-slug-status"
            value={slug()}
            oninput={(e) => {
              const { value } = e.currentTarget;
              slug.set(value);
              slugOrigin.set(value.length > 0 ? "user" : "name");
            }}
            required
          />
          <SlugStatus
            checking={state.status === "checking" && state.slug === currentSlug}
            hint={
              currentSlug !== "" && !SLUG_RE.test(currentSlug)
                ? SLUG_HINT
                : SLUG_ORIGIN_HINT[slugOrigin()]
            }
            onUse={(suggestion) => {
              slugOrigin.set("user");
              slug.set(suggestion);
            }}
            verdict={verdict}
          />
        </Row>

        <CreateNotice message={notice()} stranded={stranded()} />

        <footer class="border-base-300 bg-base-200/50 dark:bg-base-300/40 flex items-center justify-end gap-2 border-t px-6 py-3">
          <a href="/apps" class="btn btn-ghost btn-sm">
            Cancel
          </a>
          <button
            type="submit"
            class="btn btn-neutral btn-sm"
            disabled={busy()}
          >
            {busy() ? "Creating…" : "Create app"}
          </button>
        </footer>
      </form>
      <p class="text-base-content/60 m-0 flex items-center justify-center gap-1.5 text-center text-xs">
        <Folder class="h-3.5 w-3.5 shrink-0" />
        Drag a project folder anywhere on this page to create an app from it.
        Dependencies, build output and <code>.env</code> files are left out.
      </p>
      {dragging() || reading() ? <DropOverlay reading={reading()} /> : null}
    </div>
  );
};
