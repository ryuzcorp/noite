//! Pure helpers behind the create page's mode picker: what a GitHub URL (or a
//! template) means for the Name and Slug fields, and the source shape the
//! create action takes.
//!
//! The runner re-validates the URL — it is the security boundary (its clone is
//! not covered by the tenant egress policy) — so this only mirrors the obvious
//! rejections to keep the form honest before it submits.

import { slugifyName } from "./identity";

/** A GitHub repo parsed out of a URL, with the create-form defaults derived
 * from it. */
export interface GitHubRepo {
  name: string;
  owner: string;
  repo: string;
  slug: string;
}

/** What the create form asks the create action for. A template is named by id:
 * the action resolves it against the shipped list, so the client can never
 * point the import at another URL. */
export type CreateSourceInput =
  | { kind: "blank" }
  | { kind: "git"; ref?: string; url: string }
  | { kind: "template"; id: string };

const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/u;

/** `https://github.com/<owner>/<repo>(.git)` → owner, repo and the
 * Name/Slug prefills. Anything else (other scheme, host, port, credentials,
 * query, extra segments) is `null`: the runner refuses it too. */
export const parseGitHubRepo = (raw: string): GitHubRepo | null => {
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
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) {
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
  return { name: repo, owner, repo, slug: slugifyName(repo) };
};
