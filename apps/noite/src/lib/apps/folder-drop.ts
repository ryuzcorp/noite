//! Turning a project folder dropped on the app creator into the first commit of
//! a new app: what is left out of it, and the files it writes. The read itself
//! is `readDroppedItems` (shared with Code mode's tree uploads); the commit goes
//! through the same browser commit route as a web edit, so the runner's caps
//! (`UPLOAD_LIMITS`) hold here too.

import type { SourceCommitFile } from "../runner";
import { checkLimits, UPLOAD_LIMITS } from "../source/uploads";
import type { DropSkip, UploadRead } from "../source/uploads";

/** Directories a project folder never ships: installed dependencies, build
 * output, tool caches and the folder's own git metadata (the runner refuses a
 * `.git` path anyway). A build runs on the runner after the push. */
const SKIPPED_DIRS = {
  ".cache": true,
  ".git": true,
  ".next": true,
  ".nuxt": true,
  ".output": true,
  ".svelte-kit": true,
  ".turbo": true,
  ".vercel": true,
  ".wrangler": true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
} satisfies Record<string, true>;

/** OS litter that is never part of a project. */
const SKIPPED_FILES = {
  ".DS_Store": true,
  "Thumbs.db": true,
  "desktop.ini": true,
} satisfies Record<string, true>;

/** Local env files hold secrets (`.env`, `.env.local`, `.dev.vars`); the
 * documented templates (`.env.example`, `.env.sample`, `.env.template`) are
 * ordinary source and stay. */
const isSecretFile = (name: string): boolean =>
  name === ".dev.vars" ||
  (/^\.env(?:\..+)?$/u.test(name) &&
    !/\.(?:example|sample|template)$/u.test(name));

/** What a dropped project leaves out: the directories, litter and secret files
 * above, anywhere below the dropped folder itself (the folder is the root, so
 * a project named `build` still uploads). */
export const projectSkip: DropSkip = (entry, path) => {
  if (!path.includes("/")) {
    return false;
  }

  if (entry.isDirectory) {
    return Object.hasOwn(SKIPPED_DIRS, entry.name);
  }

  return Object.hasOwn(SKIPPED_FILES, entry.name) || isSecretFile(entry.name);
};

/** A dropped project, ready to commit: the files at their repository paths
 * (the dropped folder's own name stripped) and their decoded size. */
export interface ProjectUpload {
  bytes: number;
  files: SourceCommitFile[];
  name: string;
}

const UTF8 = new TextEncoder();

/** The commit a dropped folder `root` makes from what was read under it, or
 * why it can't: every file must have been readable, something must be left
 * after the skips, and the whole must fit one commit. */
export const projectUpload = (
  root: string,
  reads: readonly UploadRead[]
): { error: string } | { upload: ProjectUpload } => {
  const unreadable = reads.find((read) => read.kind === "error");

  if (unreadable) {
    return { error: `${unreadable.path} could not be read.` };
  }

  if (reads.length === 0) {
    return {
      error: `${root} has nothing to upload once dependencies, build output and env files are left out.`,
    };
  }

  const tooBig = checkLimits(reads, UPLOAD_LIMITS);

  if (tooBig) {
    return {
      error: `${tooBig} Push larger projects with git instead.`,
    };
  }

  let bytes = 0;
  const files: SourceCommitFile[] = [];

  for (const read of reads) {
    const path = read.path.slice(root.length + 1);

    if (read.kind === "text") {
      bytes += UTF8.encode(read.text).byteLength;
      // Text is the commit route's default encoding.
      files.push({ content: read.text, path });
    } else if (read.kind === "binary") {
      bytes += read.bytes;
      files.push({ content: read.base64, encoding: "base64", path });
    }
  }

  return { upload: { bytes, files, name: root } };
};
