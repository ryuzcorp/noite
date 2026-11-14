//! The create page's state machine: what the new app starts from, the Name and
//! Slug fields, the slug's availability verdict, a dropped folder, and the
//! create-and-commit flow. One model, one `update`; every command's expected
//! failure comes back as a message, so the form's one error line and its one
//! disabled button are both derived from `model.submit`.
//!
//! The knob that made the old form wrong lives in `createSourceOf` and in the
//! `submitted` transition: a dropped folder wins over the mode picker (there is
//! no "upload that also imports"), and a create whose upload failed leaves
//! `submit` in `Failed{strandedAppId}`, which the next `Submitted` retries into
//! that app instead of creating a second one.
//!
//! ```mermaid
//! stateDiagram-v2
//!   state submit {
//!     Idle --> Creating: Submitted (valid)
//!     Creating --> Failed: CreateFailed
//!     Creating --> Idle: SlugRejected (the verdict shows under the field)
//!     Creating --> Committing: Created (folder source)
//!     Creating --> [*]: Created (navigate)
//!     Committing --> Failed: CommitFailed (strandedAppId)
//!     Failed --> Committing: Submitted (retry the stranded upload)
//!     Failed --> Creating: Submitted (nothing created)
//!   }
//!   state drop {
//!     Idle --> Dragging: DragEntered
//!     Dragging --> Dragging: DragEntered
//!     Dragging --> Idle: DragLeft (depth 1)
//!     Dragging --> Reading: FolderDropped / DropRefused
//!     Reading --> Idle: FolderRead
//!   }
//!   state slugCheck {
//!     idle --> checking: the slug changed and is well formed
//!     checking --> done: SlugChecked (for this slug)
//!     checking --> failed: SlugCheckFailed (the message shows under the field)
//!     failed --> checking: the slug changed
//!     done --> checking: the slug changed
//!   }
//! ```
//!
//! Stage order is the machine, not the DOM: `mode` is inert while `source` is a
//! folder, and a verdict is only ever read for the slug it names.

import { keyed } from "@ilha/model";
import type { Cmd as ModelCmd, UpdateResult } from "@ilha/model";
import { Data, Effect, Result } from "effect";

import { api } from "../api";
import type { SlugCheck } from "../api-types";
import { commitSource } from "../commit-source";
import { errorMessage, operationMessage } from "../errors";
import type { UploadRead } from "../source/uploads";
import type { CreateSourceInput } from "./create-source";
import { parseGitHubRepo } from "./create-source";
import { projectUpload } from "./folder-drop";
import type { ProjectUpload } from "./folder-drop";
import { slugifyName } from "./identity";
import { TEMPLATES } from "./templates";

/** The three ways an app can start. A dropped folder is `../create-form`'s
 * `source`, not a fourth mode: it replaces the picker. */
export const MODE_IDS = ["blank", "import", "template"] as const;

export type ModeId = (typeof MODE_IDS)[number];

/** Where the Slug field's value came from: it follows the name until a pick
 * (template, repo URL, folder) or the user's own typing takes it over. */
export type SlugOrigin = "folder" | "name" | "repo" | "template" | "user";

export const SLUG_ORIGIN_HINT: Record<SlugOrigin, string> = {
  folder: "Taken from the folder name. Edit to override.",
  name: "Generated from the name. Edit to override.",
  repo: "Taken from the repository or folder name. Edit to override.",
  template: "Taken from the template. Edit to override.",
  user: "Lowercase letters, digits and hyphens, up to 48 characters.",
};

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

export const SLUG_HINT =
  "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit";

/** Typing settles this long before the slug is checked against the server. */
export const SLUG_CHECK_DEBOUNCE_MS = 300;

/** The slug as the runner compares it (and as the check is keyed). */
export const normalizeSlug = (raw: string): string => raw.trim().toLowerCase();

/** The Slug row's live verdict. Every non-idle state names the slug it is
 * about, so an answer that arrives after the field moved on is dropped instead
 * of being painted under a slug it does not describe. `failed` reports why the
 * check could not answer; it stays advisory (create re-validates the slug). */
export type SlugCheckState =
  | { readonly status: "idle" }
  | { readonly for: string; readonly status: "checking" }
  | {
      readonly for: string;
      readonly result: SlugCheck;
      readonly status: "done";
    }
  | {
      readonly for: string;
      readonly message: string;
      readonly status: "failed";
    };

/** What the app is created from: nothing yet, or one dropped project folder
 * (which is committed as its first commit right after the create). */
export type CreateSource =
  | { readonly t: "None" }
  | { readonly t: "Folder"; readonly upload: ProjectUpload };

/** The page-wide drag, and the read a dropped folder starts. */
export type DropState =
  | { readonly t: "Idle" }
  | { readonly t: "Dragging"; readonly depth: number }
  | { readonly t: "Reading" };

/** The create-and-commit flow, and the form's one error line. `Failed` without
 * `strandedAppId` is a plain error (validation, a refused drop, a failed
 * create); `Failed{strandedAppId}` means an app *was* created and its upload
 * failed, so the next submit retries the upload into that app. */
export type SubmitState =
  | { readonly t: "Idle" }
  | { readonly t: "Creating" }
  | { readonly t: "Committing"; readonly appId: string }
  | {
      readonly error: string;
      readonly strandedAppId?: string;
      readonly t: "Failed";
    };

export interface CreateModel {
  readonly drop: DropState;
  readonly mode: ModeId;
  /** False on the server (and until hydration): every control stays disabled
   * so a click before the handlers exist is not silently lost. */
  readonly mounted: boolean;
  readonly name: string;
  /** Subdirectory of the repo to import (a monorepo package). */
  readonly path: string;
  readonly ref: string;
  readonly slug: string;
  readonly slugCheck: SlugCheckState;
  readonly slugOrigin: SlugOrigin;
  readonly source: CreateSource;
  readonly submit: SubmitState;
  readonly templateId: string;
  readonly url: string;
}

/** The page's navigation capability, handed to the command that ends a create:
 * `update` stays pure, and the island never reaches for the router itself. */
export type Navigate = (href: string) => void;

export type Message = Data.TaggedEnum<{
  CommitFailed: { appId: string; error: string };
  CreateFailed: { error: string };
  Created: { appId: string; navigate: Navigate };
  DragEntered: Record<never, never>;
  DragLeft: Record<never, never>;
  DropRefused: Record<never, never>;
  FolderDropped: { name: string; reads: Promise<readonly UploadRead[]> };
  FolderRead: { result: { error: string } | { upload: ProjectUpload } };
  FolderRemoved: Record<never, never>;
  ModePicked: { mode: ModeId };
  Mounted: Record<never, never>;
  NameChanged: { value: string };
  PathChanged: { value: string };
  RefChanged: { value: string };
  SlugChecked: { result: SlugCheck; slug: string };
  SlugCheckFailed: { message: string; slug: string };
  SlugChanged: { value: string };
  SlugRejected: { result: SlugCheck; slug: string };
  SlugSuggestionTaken: { slug: string };
  Submitted: { navigate: Navigate };
  TemplatePicked: { id: string };
  UrlChanged: { value: string };
}>;

export const Msg = Data.taggedEnum<Message>();

export type Cmd = ModelCmd<Message>;

/** One step's answer: the next model, plus the one command it started (if
 * any). `update` adds the slug check's command on top. */
interface Step {
  readonly cmd?: Cmd | undefined;
  readonly model: CreateModel;
}

const IDLE_SLUG_CHECK: SlugCheckState = { status: "idle" };
const OFF: DropState = { t: "Idle" };
const IDLE: SubmitState = { t: "Idle" };

/** The field's error line goes away on the next edit, but a stranded app — a
 * real outcome, with a link and a retry — survives further typing. */
const cleared = (submit: SubmitState): SubmitState =>
  submit.t === "Failed" && submit.strandedAppId === undefined ? IDLE : submit;

export const initialModel = (): CreateModel => ({
  drop: OFF,
  mode: "blank",
  mounted: false,
  name: "",
  path: "",
  ref: "",
  slug: "",
  slugCheck: IDLE_SLUG_CHECK,
  slugOrigin: "name",
  source: { t: "None" },
  submit: IDLE,
  templateId: TEMPLATES[0]?.id ?? "",
  url: "",
});

/** Fill Name and Slug from a pick — a template, a repo URL, a folder.
 * `priorName` is what the previous pick put in the field: a name the user
 * typed themselves is anything else, and it stays. */
const withSource = (
  model: CreateModel,
  picked: { name?: string; slug: string },
  origin: "folder" | "repo" | "template",
  priorName = ""
): CreateModel => {
  const current = model.name.trim();
  const follows = current === "" || current === priorName.trim();

  return {
    ...model,
    name: picked.name !== undefined && follows ? picked.name : model.name,
    slug: picked.slug,
    slugOrigin: origin,
  };
};

/** The last folder of a repository path (`apps/web` → `web`). */
export const folderName = (path: string): string =>
  path.trim().replaceAll(/\/+$/gu, "").split("/").at(-1) ?? "";

/** What the create action is asked for, or why it cannot be asked yet.
 *
 * The one precedence rule: `source` decides. A folder is created as a blank
 * app and then gets its first commit, whatever the mode picker says (the
 * picker is not on screen while a folder is held, and its value is inert). */
export const createSourceOf = (
  model: CreateModel
): { error: string } | { source: CreateSourceInput } => {
  if (model.source.t === "Folder") {
    return { source: { kind: "blank" } };
  }

  if (model.mode === "import") {
    const repo = parseGitHubRepo(model.url);

    if (!repo) {
      return {
        error:
          "Enter a public GitHub repository URL, e.g. https://github.com/owner/repo",
      };
    }

    // The branch and folder stay out when their fields are empty: an
    // explicit `undefined` is not a JSON value, and the action's argument
    // codec refuses the whole call over it ("Expected JSON value at [args][0]").
    const branch = model.ref.trim();
    const folder = model.path.trim().replaceAll(/^\/+|\/+$/gu, "");

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

  if (model.mode === "template") {
    const picked = TEMPLATES.find((t) => t.id === model.templateId);

    return picked
      ? { source: { id: picked.id, kind: "template" } }
      : { error: "Pick a template" };
  }

  return { source: { kind: "blank" } };
};

/** What the view paints from `submit` and the slug check. One derivation, so
 * the button, the notice and the Slug field can never disagree: `verdict` is
 * the answer for exactly the slug the field holds now (never one for a slug it
 * used to hold), and `stranded` is the app a failed upload left behind — the
 * one the notice links to and the next submit retries into. */
export interface CreateStatus {
  readonly busy: boolean;
  readonly checking: boolean;
  readonly error: string | null;
  readonly retrying: boolean;
  readonly slugError: string | null;
  readonly stranded: string | null;
  readonly verdict: SlugCheck | null;
}

export const statusOf = (model: CreateModel): CreateStatus => {
  const slug = normalizeSlug(model.slug);
  const check = model.slugCheck;

  // The app this flow created, if any: still the stranded one while its retry
  // uploads, so the notice (and its link) does not blink out mid-flight.
  let created: string | undefined;

  if (model.submit.t === "Committing") {
    created = model.submit.appId;
  } else if (model.submit.t === "Failed") {
    created = model.submit.strandedAppId;
  }

  return {
    busy: model.submit.t === "Creating" || model.submit.t === "Committing",
    checking: check.status === "checking" && check.for === slug,
    error: model.submit.t === "Failed" ? model.submit.error : null,
    retrying: created !== undefined,
    slugError:
      check.status === "failed" && check.for === slug ? check.message : null,
    stranded: created ?? null,
    verdict:
      check.status === "done" && check.for === slug ? check.result : null,
  };
};

/** Whether a create (or its upload) is in flight: the one rule behind the
 * disabled button, the refused drop and the refused second submit. */
const busy = (model: CreateModel): boolean =>
  model.submit.t === "Creating" || model.submit.t === "Committing";

/** Focus the Slug field: a slug lost to a race belongs there, not in the
 * notice. A command, because `update` is pure. */
const FOCUS_SLUG: Cmd = Effect.sync(() => {
  if (typeof document === "undefined") {
    return;
  }

  document.querySelector<HTMLElement>("#create-slug")?.focus();
});

/** Focus the URL field once the import row is on screen. */
const FOCUS_URL: Cmd = Effect.sync(() => {
  if (typeof window === "undefined") {
    return;
  }

  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>("#create-url")?.focus();
  });
});

/** Ask the server about `slug`; the answer names the slug it answered for. */
const checkSlug = (slug: string): Cmd =>
  Effect.gen(function* ask() {
    yield* Effect.sleep(SLUG_CHECK_DEBOUNCE_MS);

    const asked = yield* Effect.result(
      Effect.tryPromise(() => api<SlugCheck>("/api/apps/slugCheck", { slug }))
    );

    return Result.match(asked, {
      onFailure: (error) =>
        Msg.SlugCheckFailed({
          message: operationMessage("Checking the slug failed", error),
          slug,
        }),
      onSuccess: (result) => Msg.SlugChecked({ result, slug }),
    });
  });

/** Every slug change re-arms the check. One place, so a prefilled slug (a repo
 * URL, a template, a folder) is checked exactly like a keystroke, and a stale
 * answer can never be mistaken for this slug's. */
const armSlugCheck = (model: CreateModel) => {
  const slug = normalizeSlug(model.slug);

  if (slug === "" || !SLUG_RE.test(slug)) {
    return { cmd: undefined, model: { ...model, slugCheck: IDLE_SLUG_CHECK } };
  }

  return {
    cmd: keyed("slug-check", checkSlug(slug)),
    model: {
      ...model,
      slugCheck: { for: slug, status: "checking" } satisfies SlugCheckState,
    },
  };
};

/** Create the app, then either hand the browser to it (nothing to upload) or
 * start its first commit. A create rejected because the slug went away belongs
 * under the Slug field: re-ask, and report it there when the server agrees. */
const createApp = (input: {
  name: string;
  navigate: Navigate;
  slug: string;
  source: CreateSourceInput;
}): Cmd =>
  Effect.gen(function* create() {
    const created = yield* Effect.result(
      Effect.tryPromise(() =>
        api<{ id: string }>("/api/apps/create", {
          name: input.name,
          slug: input.slug,
          source: input.source,
        })
      )
    );

    if (Result.isSuccess(created)) {
      return Msg.Created({
        appId: created.success.id,
        navigate: input.navigate,
      });
    }

    const recheck = yield* Effect.result(
      Effect.tryPromise(() =>
        api<SlugCheck>("/api/apps/slugCheck", { slug: input.slug })
      )
    );

    if (Result.isSuccess(recheck) && recheck.success.error !== null) {
      return Msg.SlugRejected({ result: recheck.success, slug: input.slug });
    }

    return Msg.CreateFailed({
      error: operationMessage("Creating the app failed", created.failure),
    });
  });

/** The dropped folder's first commit. Its failure is not the end of the app —
 * it exists — so the message carries the id the retry needs. */
const commitFolder = (
  appId: string,
  upload: ProjectUpload,
  navigate: Navigate
): Cmd =>
  Effect.gen(function* commit() {
    const committed = yield* Effect.result(
      Effect.tryPromise(() =>
        commitSource({
          appId,
          files: upload.files,
          message: `Upload ${upload.name}`,
        })
      )
    );

    if (Result.isFailure(committed)) {
      return Msg.CommitFailed({
        appId,
        error: errorMessage(committed.failure),
      });
    }

    yield* Effect.sync(() => {
      navigate(`/apps/${appId}?t=deployments`);
    });
  });

/** Read what was dropped into a project upload, or say why it cannot be one. */
const readFolder = (name: string, reads: Promise<readonly UploadRead[]>): Cmd =>
  Effect.gen(function* read() {
    const settled = yield* Effect.result(Effect.tryPromise(() => reads));

    if (Result.isFailure(settled)) {
      return Msg.FolderRead({
        result: {
          error: operationMessage("Reading the folder failed", settled.failure),
        },
      });
    }

    return Msg.FolderRead({ result: projectUpload(name, settled.success) });
  });

/** Validate, then create. One transition, so "can this be submitted" has one
 * answer and a double submit cannot start two creates. */
const submitted = (model: CreateModel, navigate: Navigate): Step => {
  // A create in flight owns the form, and a folder still being read is about to
  // replace the source: submitting now would create from a state that is
  // already stale.
  if (busy(model) || model.drop.t === "Reading") {
    return { model };
  }

  const status = statusOf(model);

  // A stranded app is uploaded into, never created again — and with the folder
  // gone there is nothing to upload, so the advice is to bring it back rather
  // than to create a second app.
  if (status.stranded !== null) {
    const appId = status.stranded;

    if (model.source.t === "Folder") {
      return {
        cmd: keyed(
          "commit",
          commitFolder(appId, model.source.upload, navigate)
        ),
        model: { ...model, submit: { appId, t: "Committing" } },
      };
    }

    return {
      model: {
        ...model,
        submit: {
          error: `The app was created, but its files were never uploaded. Drop the folder again to retry, or open the app to push yourself.`,
          strandedAppId: appId,
          t: "Failed",
        },
      },
    };
  }

  const name = model.name.trim();
  const slug = normalizeSlug(model.slug) || slugifyName(name);

  if (!(name && slug)) {
    return {
      model: {
        ...model,
        submit: { error: "Name and slug are required", t: "Failed" },
      },
    };
  }

  if (!SLUG_RE.test(slug)) {
    return { model: { ...model, submit: { error: SLUG_HINT, t: "Failed" } } };
  }

  if (status.verdict?.error) {
    return { cmd: FOCUS_SLUG, model };
  }

  const picked = createSourceOf(model);

  if ("error" in picked) {
    return {
      model: { ...model, submit: { error: picked.error, t: "Failed" } },
    };
  }

  return {
    cmd: keyed(
      "create",
      createApp({ name, navigate, slug, source: picked.source })
    ),
    model: { ...model, submit: { t: "Creating" } },
  };
};

const step = (model: CreateModel, message: Message): Step =>
  Msg.$match(message, {
    CommitFailed: (failed): Step => ({
      model: {
        ...model,
        submit: {
          error: `The app was created, but the folder could not be committed: ${failed.error}`,
          strandedAppId: failed.appId,
          t: "Failed",
        },
      },
    }),
    CreateFailed: (failed): Step => ({
      model: { ...model, submit: { error: failed.error, t: "Failed" } },
    }),
    Created: (created): Step => {
      if (model.source.t === "Folder") {
        return {
          cmd: keyed(
            "commit",
            commitFolder(created.appId, model.source.upload, created.navigate)
          ),
          model: {
            ...model,
            submit: { appId: created.appId, t: "Committing" },
          },
        };
      }

      // A blank app's next step is a push, which its Overview explains; an
      // import or template is already building, which Deployments shows.
      return {
        cmd: Effect.sync(() => {
          created.navigate(
            model.mode === "blank"
              ? `/apps/${created.appId}`
              : `/apps/${created.appId}?t=deployments`
          );
        }),
        model,
      };
    },
    DragEntered: (): Step => ({
      model: {
        ...model,
        // The overlay is cosmetic: a drag over a running read does not cancel it.
        drop:
          model.drop.t === "Reading"
            ? model.drop
            : {
                depth: model.drop.t === "Dragging" ? model.drop.depth + 1 : 1,
                t: "Dragging",
              },
      },
    }),
    DragLeft: (): Step => {
      if (model.drop.t !== "Dragging") {
        return { model };
      }

      return {
        model: {
          ...model,
          drop:
            model.drop.depth > 1
              ? { depth: model.drop.depth - 1, t: "Dragging" }
              : OFF,
        },
      };
    },
    DropRefused: (): Step => ({
      model: {
        ...model,
        drop: OFF,
        submit: { error: "Drop one folder: your project's root.", t: "Failed" },
      },
    }),
    FolderDropped: (dropped): Step => {
      if (busy(model)) {
        return { model: { ...model, drop: OFF } };
      }

      return {
        cmd: keyed("read-folder", readFolder(dropped.name, dropped.reads)),
        model: {
          ...model,
          drop: { t: "Reading" },
          submit: cleared(model.submit),
        },
      };
    },
    FolderRead: (read): Step => {
      // A read that lands after a create started is not this form's source any
      // more: dropping it in would un-idle a create in flight.
      if (busy(model)) {
        return { model: { ...model, drop: OFF } };
      }

      if ("error" in read.result) {
        return {
          model: {
            ...model,
            drop: OFF,
            submit: { error: read.result.error, t: "Failed" },
          },
        };
      }

      const { upload } = read.result;

      const previous =
        model.source.t === "Folder" ? model.source.upload.name : "";

      // A dropped folder starts a fresh flow: a stranded app from an earlier
      // upload is abandoned here (its notice goes away with it), because the
      // new files were not the ones that failed to upload.
      const next = withSource(
        {
          // The folder replaces the picker; `mode` goes back to its default so
          // removing the folder leaves the form where it started.
          ...model,
          drop: OFF,
          mode: "blank",
          source: { t: "Folder", upload },
          submit: IDLE,
        },
        { name: upload.name, slug: slugifyName(upload.name) },
        "folder",
        previous
      );

      return { model: next };
    },
    FolderRemoved: (): Step => {
      const next: CreateModel = {
        ...model,
        drop: OFF,
        mode: "blank",
        source: { t: "None" },
        // A stranded app's link (and the rule that its upload is retried, never
        // a second app created) outlives the folder it was dropped from.
        submit: cleared(model.submit),
      };

      return {
        model:
          model.slugOrigin === "folder"
            ? {
                ...next,
                slug: slugifyName(model.name),
                slugOrigin: "name",
              }
            : next,
      };
    },
    ModePicked: (picked): Step => {
      const next: CreateModel = {
        ...model,
        mode: picked.mode,
        submit: cleared(model.submit),
      };

      if (picked.mode === "blank") {
        // A blank app has no repo to take the slug from: let the name drive it
        // again, unless the user typed one.
        if (model.slugOrigin === "user") {
          return { model: next };
        }

        return {
          model: {
            ...next,
            slug: slugifyName(model.name),
            slugOrigin: "name",
          },
        };
      }

      if (picked.mode === "template") {
        const template = TEMPLATES.find((t) => t.id === model.templateId);

        return {
          model: template
            ? withSource(
                next,
                { name: template.name, slug: slugifyName(template.id) },
                "template",
                template.name
              )
            : next,
        };
      }

      const repo = parseGitHubRepo(model.url);

      return {
        cmd: FOCUS_URL,
        model: repo
          ? withSource(
              next,
              { name: repo.name, slug: repo.slug },
              "repo",
              repo.name
            )
          : next,
      };
    },
    Mounted: (): Step => ({ model: { ...model, mounted: true } }),
    NameChanged: (changed): Step => {
      const next: CreateModel = {
        ...model,
        name: changed.value,
        submit: cleared(model.submit),
      };

      return {
        model:
          model.slugOrigin === "name"
            ? { ...next, slug: slugifyName(changed.value) }
            : next,
      };
    },
    PathChanged: (changed): Step => {
      const repo = parseGitHubRepo(model.url);
      const previous = folderName(model.path);

      const next: CreateModel = {
        ...model,
        path: changed.value,
        submit: cleared(model.submit),
      };

      if (model.slugOrigin !== "repo") {
        return { model: next };
      }

      const named = folderName(changed.value) || repo?.name || "";

      // A folder names the app, like a repo does, until the user types a name
      // or slug of their own.
      return {
        model: repo
          ? withSource(
              next,
              { name: named, slug: slugifyName(named) },
              "repo",
              previous || repo.name
            )
          : next,
      };
    },
    RefChanged: (changed): Step => ({
      model: { ...model, ref: changed.value, submit: cleared(model.submit) },
    }),
    SlugChanged: (changed): Step => ({
      model: {
        ...model,
        slug: changed.value,
        slugOrigin: changed.value.length > 0 ? "user" : "name",
        submit: cleared(model.submit),
      },
    }),
    SlugCheckFailed: (failed): Step => {
      if (normalizeSlug(model.slug) !== failed.slug) {
        return { model };
      }

      // The check is advisory: create re-validates, so a failed check reports
      // why under the field rather than blocking the form.
      return {
        model: {
          ...model,
          slugCheck: {
            for: failed.slug,
            message: failed.message,
            status: "failed",
          },
        },
      };
    },
    SlugChecked: (checked): Step => {
      // An answer for a slug the field no longer holds is not a verdict.
      if (normalizeSlug(model.slug) !== checked.slug) {
        return { model };
      }

      return {
        model: {
          ...model,
          slugCheck: {
            for: checked.slug,
            result: checked.result,
            status: "done",
          },
        },
      };
    },
    SlugRejected: (rejected): Step => ({
      cmd: FOCUS_SLUG,
      model: {
        ...model,
        slugCheck:
          normalizeSlug(model.slug) === rejected.slug
            ? { for: rejected.slug, result: rejected.result, status: "done" }
            : model.slugCheck,
        submit: IDLE,
      },
    }),
    SlugSuggestionTaken: (taken): Step => ({
      model: { ...model, slug: taken.slug, slugOrigin: "user" },
    }),
    Submitted: (submit): Step => submitted(model, submit.navigate),
    TemplatePicked: (picked): Step => {
      const previous = TEMPLATES.find((t) => t.id === model.templateId);
      const template = TEMPLATES.find((t) => t.id === picked.id);

      if (!template) {
        return { model };
      }

      return {
        model: withSource(
          { ...model, submit: cleared(model.submit), templateId: template.id },
          { name: template.name, slug: slugifyName(template.id) },
          "template",
          previous?.name ?? ""
        ),
      };
    },
    UrlChanged: (changed): Step => {
      const previous = parseGitHubRepo(model.url);
      const parsed = parseGitHubRepo(changed.value);

      let next: CreateModel = {
        ...model,
        submit: cleared(model.submit),
        url: changed.value,
      };

      if (parsed) {
        // A pasted folder link fills the branch and folder too.
        if (parsed.ref !== undefined) {
          next = { ...next, path: parsed.path ?? "", ref: parsed.ref };
        }

        next = withSource(
          next,
          { name: parsed.name, slug: parsed.slug },
          "repo",
          previous?.name ?? ""
        );
      }

      return { model: next };
    },
  });

/** The one transition function: every state change goes through here, and every
 * slug change re-arms the check from the same place. */
export const update = (
  model: CreateModel,
  message: Message
): UpdateResult<CreateModel, Message> => {
  const stepped = step(model, message);

  if (stepped.model.slug === model.slug) {
    return stepped;
  }

  const armed = armSlugCheck(stepped.model);

  const cmds = [stepped.cmd, armed.cmd].filter(
    (cmd): cmd is Cmd => cmd !== undefined
  );

  return cmds.length === 0
    ? { model: armed.model }
    : { cmd: cmds, model: armed.model };
};
