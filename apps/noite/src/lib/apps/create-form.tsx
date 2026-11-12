//! The create page's form: pick what the new app starts as — an empty repo, a
//! public GitHub repo (A2), or a shipped template (A3) — then Name and Slug.
//! Laid out as labelled rows (label left, control right) in one card with a
//! Cancel / Create footer; the Slug row checks the slug while you type and
//! shows the URL and git remote it would get.
//!
//! The form is one `@ilha/model` island: `./create-machine` holds the states,
//! the messages and the one `update`, so this file only maps the DOM onto
//! messages and paints the returned model. Submitting posts straight to the
//! JSON action (`api()`), because a create must read the new id from the
//! response (and possibly commit an upload first) before navigating to the new
//! app — `useForm` posts to a page action and refreshes page props, which is
//! not the same thing.

import { defineApp, subscription } from "@ilha/model";
import type { Dispatch } from "@ilha/model";
import { Link, useRouter } from "@ilha/void";
import { Effect, Queue, Stream } from "effect";
import type { View } from "ilha";

import type { SlugCheck } from "../api-types";
import { formatBytes } from "../bytes";
import { readDroppedItems } from "../source/uploads";
import {
  ArrowUpRight,
  Check,
  Folder,
  Github,
  LayoutTemplate,
  Plus,
} from "../ui/icons";
import type { CreateModel, Message } from "./create-machine";
import {
  initialModel,
  Msg,
  normalizeSlug,
  SLUG_HINT,
  SLUG_ORIGIN_HINT,
  SLUG_RE,
  statusOf,
  update,
} from "./create-machine";
import type { GitHubRepo } from "./create-source";
import { parseGitHubRepo } from "./create-source";
import { projectSkip } from "./folder-drop";
import type { ProjectUpload } from "./folder-drop";
import { appUrl } from "./identity";
import { TEMPLATES } from "./templates";

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

/** Under the Slug field: why it can't be used (with a free variant to take),
 * why the check itself failed, where it came from while it's being checked,
 * and the URL and git remote it gets once it's free. */
const SlugStatus = ({
  checking,
  failure,
  hint,
  onUse,
  verdict,
}: {
  checking: boolean;
  failure: string | null;
  hint: string;
  onUse: (suggestion: string) => void;
  verdict: SlugCheck | null;
}) => {
  let firstLine: View;

  if (failure) {
    firstLine = <span class="text-error">{failure}</span>;
  } else if (verdict?.error) {
    firstLine = (
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
    );
  } else {
    firstLine = <span class="text-base-content/60">{hint}</span>;
  }

  return (
    <div
      id="create-slug-status"
      class="flex flex-col gap-1 text-xs"
      aria-live="polite"
    >
      {firstLine}
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
};

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

/** The page-wide drop zone's listeners, attached to `emit` and detached by the
 * returned function. `depth` counts nested enter/leave pairs, which fire for
 * every element the drag crosses — the model holds the count, so it survives a
 * re-render. */
const attachDropListeners = (
  emit: (message: Message) => void
): (() => void) => {
  const enter = (event: DragEvent) => {
    if (isFileDrag(event)) {
      event.preventDefault();
      emit(Msg.DragEntered());
    }
  };

  const leave = (event: DragEvent) => {
    if (isFileDrag(event)) {
      emit(Msg.DragLeft());
    }
  };

  const drop = (event: DragEvent) => {
    if (!isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    const items = event.dataTransfer?.items;

    if (!items) {
      emit(Msg.DragLeft());

      return;
    }

    const entries = [...items].map((item) => item.webkitGetAsEntry?.() ?? null);
    const [root] = entries;

    if (entries.length !== 1 || !root?.isDirectory) {
      emit(Msg.DropRefused());

      return;
    }

    // Read inside the event: a `DataTransferItemList` empties as soon as the
    // drop handler returns.
    emit(
      Msg.FolderDropped({
        name: root.name,
        reads: readDroppedItems(items, projectSkip),
      })
    );
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
};

/** The drop zone as a subscription: it starts on the client mount only (never
 * during server rendering) and its finalizer detaches the listeners on
 * unmount. */
const dragAndDrop = subscription({
  deps: () => null,
  stream: () =>
    Stream.callback<Message>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          attachDropListeners((message) => {
            Queue.offerUnsafe(queue, message);
          })
        ),
        (release) => Effect.sync(release)
      )
    ),
});

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

/** The form's one error line; `stranded` names an app that was created before
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
              <Link href={`/apps/${stranded}`} class="link">
                Open the app
              </Link>
            </>
          ) : null}
        </span>
      </div>
    </div>
  ) : null;

/** The model, painted. */
const CreateForm = (model: CreateModel, dispatch: Dispatch<Message>): View => {
  const router = useRouter();
  const status = statusOf(model);

  const submitted = (event: SubmitEvent) => {
    event.preventDefault();
    dispatch(
      Msg.Submitted({
        navigate: (href) => {
          router.visit(href);
        },
      })
    );
  };

  let label = "Create app";

  if (status.busy) {
    label = "Creating…";
  } else if (status.retrying) {
    label = "Retry upload";
  }

  const repo = parseGitHubRepo(model.url);
  const dropped = model.source.t === "Folder" ? model.source.upload : null;
  const currentSlug = normalizeSlug(model.slug);

  return (
    <div class="flex flex-col gap-3">
      <form
        onsubmit={submitted}
        class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box overflow-hidden border shadow-sm"
        novalidate
      >
        {/* Server-rendered with its fields in place but no handlers until the
         * client mounts: a control that cannot act stays disabled. */}
        <fieldset
          class="m-0 flex min-w-0 flex-col border-0 p-0"
          disabled={!model.mounted}
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
                  dispatch(Msg.FolderRemoved());
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
                      checked={model.mode === m.id}
                      onchange={() => {
                        dispatch(Msg.ModePicked({ mode: m.id }));
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

          {model.mode === "import" ? (
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
                value={model.url}
                oninput={(e) => {
                  dispatch(Msg.UrlChanged({ value: e.currentTarget.value }));
                }}
                required
              />
              <ImportSummary
                path={model.path}
                reference={model.ref}
                repo={repo}
              />
              <ImportOptions
                path={model.path}
                reference={model.ref}
                onPath={(value) => {
                  dispatch(Msg.PathChanged({ value }));
                }}
                onReference={(value) => {
                  dispatch(Msg.RefChanged({ value }));
                }}
              />
            </Row>
          ) : null}

          {model.mode === "template" ? (
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
                      checked={model.templateId === t.id}
                      onchange={() => {
                        dispatch(Msg.TemplatePicked({ id: t.id }));
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

          <Row
            htmlFor="create-name"
            label="Name"
            note="Shown in the dashboard."
          >
            <input
              id="create-name"
              name="name"
              class="input w-full"
              placeholder="My Service"
              autocomplete="off"
              value={model.name}
              oninput={(e) => {
                dispatch(Msg.NameChanged({ value: e.currentTarget.value }));
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
              class={`input w-full font-mono ${status.verdict?.error ? "input-error" : ""}`}
              placeholder="my-app"
              maxlength={48}
              autocomplete="off"
              spellcheck={false}
              aria-invalid={status.verdict?.error ? "true" : "false"}
              aria-describedby="create-slug-status"
              value={model.slug}
              oninput={(e) => {
                dispatch(Msg.SlugChanged({ value: e.currentTarget.value }));
              }}
              required
            />
            <SlugStatus
              checking={status.checking}
              failure={status.slugError}
              hint={
                currentSlug !== "" && !SLUG_RE.test(currentSlug)
                  ? SLUG_HINT
                  : SLUG_ORIGIN_HINT[model.slugOrigin]
              }
              onUse={(suggestion) => {
                dispatch(Msg.SlugSuggestionTaken({ slug: suggestion }));
              }}
              verdict={status.verdict}
            />
          </Row>

          <CreateNotice message={status.error} stranded={status.stranded} />

          <footer class="border-base-300 bg-base-200/50 dark:bg-base-300/40 flex items-center justify-end gap-2 border-t px-6 py-3">
            <Link href="/apps" class="btn btn-ghost btn-sm">
              Cancel
            </Link>
            <button
              type="submit"
              class="btn btn-neutral btn-sm"
              disabled={
                status.busy || !model.mounted || model.drop.t === "Reading"
              }
            >
              {label}
            </button>
          </footer>
        </fieldset>
      </form>
      <p class="text-base-content/60 m-0 flex items-center justify-center gap-1.5 text-center text-xs">
        <Folder class="h-3.5 w-3.5 shrink-0" />
        Drag a project folder anywhere on this page to create an app from it.
        Dependencies, build output and <code>.env</code> files are left out.
      </p>
      {model.drop.t === "Dragging" || model.drop.t === "Reading" ? (
        <DropOverlay reading={model.drop.t === "Reading"} />
      ) : null}
    </div>
  );
};

/** The create page's form (states and transitions: `./create-machine`). */
export const CreateAppForm = defineApp({
  // The first render is the server's (or the pre-hydration one): the island
  // proves it mounted through a command, which never runs on the server.
  init: () => ({
    cmd: Effect.sync(() => Msg.Mounted()),
    model: initialModel(),
  }),
  name: "CreateAppForm",
  subscriptions: [dragAndDrop],
  update,
  view: CreateForm,
}).component;
