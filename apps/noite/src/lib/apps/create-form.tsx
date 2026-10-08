//! The create page's form: pick what the new app starts as — an empty repo, a
//! public GitHub repo (A2), or a shipped template (A3) — then Name and Slug.

import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";
import { createMutationQueue } from "oxidejs/mutation-queue";

import { errorMessage } from "../errors";
import { create } from "../server/apps.server";
import type { CreateSourceInput } from "./create-source";
import { parseGitHubRepo } from "./create-source";
import { slugifyName } from "./identity";
import { TEMPLATES } from "./templates";

// Same queue the old form used: a double submit for one slug creates one app.
const queue = createMutationQueue();
const createQueued = queue.wrap(create, {
  idempotencyKey: ({ slug }) => `create:${slug}`,
});

const MODES = [
  {
    hint: "An empty repository — push when you're ready.",
    id: "blank",
    label: "Blank",
  },
  {
    hint: "A one-time copy of a public GitHub repo, history included.",
    id: "import",
    label: "Import from GitHub",
  },
  {
    hint: "Start from a template, as one initial commit.",
    id: "template",
    label: "Template",
  },
] as const;

type ModeId = (typeof MODES)[number]["id"];

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;
const SLUG_HINT =
  "Slug must be 1–48 chars: lowercase letters, digits, and hyphens, starting and ending with a letter or digit";

export const CreateAppForm = () => {
  const notice = atom<string | null>(null);
  const busy = atom(false);
  const mode = atom<ModeId>("blank");
  const name = atom("");
  const slug = atom("");
  const url = atom("");
  const ref = atom("");
  const templateId = atom(TEMPLATES[0]?.id ?? "");
  // A slug the user typed stops following the name; a slug a source picked
  // stops following both (changing the URL re-picks it).
  const slugTouched = atom(false);
  const slugSourced = atom(false);
  /** Fill Name and Slug from a pick — a template, or the repo a URL names.
   * `priorName` is what the previous pick put in the field: a name the user
   * typed themselves is anything else, and it stays. Picking a second
   * template used to move the slug but leave the first one's name behind. */
  const applySource = (
    picked: { name?: string; slug: string },
    priorName = ""
  ) => {
    slugSourced.set(true);
    const current = name().trim();
    if (picked.name && (current === "" || current === priorName.trim())) {
      name.set(picked.name);
    }
    slug.set(picked.slug);
  };

  watch(name, (value) => {
    if (!(slugTouched() || slugSourced())) {
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
    if (!SLUG_RE.test(nextSlug)) {
      notice.set(SLUG_HINT);
      return;
    }
    let source: CreateSourceInput;
    if (mode() === "import") {
      const repo = parseGitHubRepo(url());
      if (!repo) {
        notice.set(
          "Enter a public GitHub repository URL, e.g. https://github.com/owner/repo"
        );
        return;
      }
      // The branch stays out when the field is empty: an explicit `undefined`
      // is not a JSON value, and the action's RPC encoder refuses the whole
      // call over it ("Expected JSON value at [args][0]").
      const branch = ref().trim();
      const imported: Extract<CreateSourceInput, { kind: "git" }> = {
        kind: "git",
        url: `https://github.com/${repo.owner}/${repo.repo}`,
      };
      if (branch !== "") {
        imported.ref = branch;
      }
      source = imported;
    } else if (mode() === "template") {
      const picked = TEMPLATES.find((t) => t.id === templateId());
      if (!picked) {
        notice.set("Pick a template");
        return;
      }
      source = { id: picked.id, kind: "template" };
    } else {
      source = { kind: "blank" };
    }
    try {
      busy.set(true);
      await createQueued({ name: trimmedName, slug: nextSlug, source });
      // SPA nav keeps CSS/DOM parsed; the apps SSE stream adds the new row.
      navigate("/apps");
    } catch (error) {
      busy.set(false);
      notice.set(errorMessage(error));
    }
  };

  return (
    <form onsubmit={submit} class="flex flex-col gap-4">
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      <div class="flex flex-col gap-2">
        <div role="tablist" class="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              type="button"
              role="tab"
              aria-selected={mode() === m.id ? "true" : "false"}
              class={`btn btn-sm ${mode() === m.id ? "btn-neutral" : "btn-ghost"}`}
              onclick={() => {
                mode.set(m.id);
                if (m.id === "blank") {
                  // A blank app has no repo to take the slug from: let the
                  // name drive it again.
                  slugSourced.set(false);
                  return;
                }
                if (m.id === "template") {
                  const picked = TEMPLATES.find((t) => t.id === templateId());
                  if (picked) {
                    applySource(
                      { name: picked.name, slug: slugifyName(picked.id) },
                      picked.name
                    );
                  }
                  return;
                }
                if (m.id === "import") {
                  const repo = parseGitHubRepo(url());
                  if (repo) {
                    applySource(
                      { name: repo.name, slug: repo.slug },
                      repo.name
                    );
                  }
                }
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p class="text-base-content/70 m-0 text-xs">
          {MODES.find((m) => m.id === mode())?.hint}
        </p>
      </div>

      {mode() === "import" ? (
        <>
          <fieldset class="fieldset">
            <label class="label" for="create-url">
              Repository URL
            </label>
            <input
              id="create-url"
              name="url"
              type="url"
              class="input w-full"
              placeholder="https://github.com/owner/repo"
              value={url()}
              oninput={(e) => {
                const previous = parseGitHubRepo(url());
                url.set(e.currentTarget.value);
                const repo = parseGitHubRepo(e.currentTarget.value);
                if (repo) {
                  applySource(
                    { name: repo.name, slug: repo.slug },
                    previous?.name ?? ""
                  );
                }
              }}
              required
            />
            <p class="label">
              A public GitHub repo. It is copied once — Noite's repo becomes the
              source of truth (no upstream link).
            </p>
          </fieldset>
          <fieldset class="fieldset">
            <label class="label" for="create-ref">
              Branch or tag
            </label>
            <input
              id="create-ref"
              name="ref"
              class="input w-full"
              placeholder="the repo's default branch"
              value={ref()}
              oninput={(e) => {
                ref.set(e.currentTarget.value);
              }}
            />
          </fieldset>
        </>
      ) : null}

      {mode() === "template" ? (
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                aria-pressed={templateId() === t.id ? "true" : "false"}
                class={`border-base-300 hover:border-base-content/40 rounded-box flex w-full flex-col items-start gap-1 border p-3 text-left ${
                  templateId() === t.id
                    ? "border-neutral bg-base-200 dark:bg-base-300"
                    : "bg-base-100 dark:bg-base-200"
                }`}
                onclick={() => {
                  const previous = TEMPLATES.find(
                    (template) => template.id === templateId()
                  );
                  templateId.set(t.id);
                  applySource(
                    { name: t.name, slug: slugifyName(t.id) },
                    previous?.name ?? ""
                  );
                }}
              >
                <span class="text-sm font-semibold">{t.name}</span>
                <span class="text-base-content/70 text-xs">
                  {t.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
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
