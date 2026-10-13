//! Pure helpers behind the create page's mode picker: what a GitHub URL (or a
//! template) means for the Name and Slug fields, and the source shape the
//! create action takes.
//!
//! The runner re-validates the URL — it is the security boundary (its clone is
//! not covered by the tenant egress policy) — so this only mirrors the obvious
//! rejections to keep the form honest before it submits.

import { slugifyName } from "./identity";

/** A GitHub repo parsed out of a URL, with the create-form defaults derived
 * from it. A folder link (`…/tree/<ref>/<path>`, what GitHub's address bar
 * shows inside a monorepo) also yields the ref and the subdirectory. */
export interface GitHubRepo {
  name: string;
  owner: string;
  /** The subdirectory a folder link points at. */
  path?: string;
  /** The branch, tag or sha a `/tree/<ref>` link names. */
  ref?: string;
  repo: string;
  slug: string;
}

/** What the create form asks the create action for. A template is named by id:
 * the action resolves it against the shipped list, so the client can never
 * point the import at another URL. `path` imports one subdirectory of the repo
 * (a monorepo package) as the app's root. */
export type CreateSourceInput =
  | { kind: "blank" }
  | { kind: "git"; path?: string; ref?: string; url: string }
  | { kind: "template"; id: string };

const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/u;

/** `raw` as a URL on exactly `https://github.com`: no port, credentials,
 * query or fragment. */
const githubHttpsUrl = (raw: string): URL | null => {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain =
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === "github.com" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  return plain ? url : null;
};

/** `https://github.com/<owner>/<repo>(.git)`, or a folder link
 * `https://github.com/<owner>/<repo>/tree/<ref>[/<path>]` → owner, repo (and
 * ref/path) plus the Name/Slug prefills, which follow the folder when there is
 * one. Anything else (other scheme, host, port, credentials, query, other
 * extra segments) is `null`: the runner refuses it too. A ref with a slash in
 * it (`release/1.x`) can't be told apart from a path here; the form's fields
 * correct that. */
export const parseGitHubRepo = (raw: string): GitHubRepo | null => {
  const url = githubHttpsUrl(raw);
  if (!url) {
    return null;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const folderLink = parts.length >= 4 && parts[2] === "tree";
  if (parts.length !== 2 && !folderLink) {
    return null;
  }
  const [owner = "", rawRepo = ""] = parts;
  const repo = rawRepo.replace(/\.git$/u, "");
  if (
    !(SEGMENT_RE.test(owner) && SEGMENT_RE.test(repo)) ||
    owner.startsWith("-") ||
    repo.startsWith("-")
  ) {
    return null;
  }
  const parsed: GitHubRepo = {
    name: repo,
    owner,
    repo,
    slug: slugifyName(repo),
  };
  if (folderLink) {
    const [ref, ...folders] = parts.slice(3);
    parsed.ref = ref;
    if (folders.length > 0) {
      const folder = folders.at(-1) ?? repo;
      parsed.path = folders.join("/");
      parsed.name = folder;
      parsed.slug = slugifyName(folder);
    }
  }
  return parsed;
};
