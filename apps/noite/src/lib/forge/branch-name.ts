/** Branch-name rules shared by the branch picker's Create input and the
 * Changes panel's new-branch input, mirroring the runner's own
 * `valid_branch_name` in `apps/runner/src/host/forge.rs`: the same name must
 * be refused here with a reason the user can act on, instead of coming back
 * as a server error. Returns a short reason, or null when the name is fine. */

/** Longest accepted name, the runner's own cap (bytes, as Rust counts). */
const MAX_LENGTH = 200;

const utf8 = new TextEncoder();

/** Characters git refuses anywhere in a ref name. */
const FORBIDDEN = " ~^:?*[\\";

/** Whether one `/`-separated component is a legal path piece. */
const badComponent = (part: string): string | null => {
  if (part === "") {
    return "Branch name can't contain an empty part.";
  }
  if (part.startsWith(".")) {
    return "No part of a branch name can start with '.'.";
  }
  if (part.endsWith(".lock")) {
    return "No part of a branch name can end with '.lock'.";
  }
  return null;
};

export const branchNameError = (name: string): string | null => {
  if (name === "") {
    return "Enter a branch name.";
  }
  if (utf8.encode(name).length > MAX_LENGTH) {
    return `Branch name is too long (max ${MAX_LENGTH} bytes).`;
  }
  if (name === "HEAD") {
    return "'HEAD' is reserved.";
  }
  if (name.startsWith("-")) {
    return "Branch name can't start with '-'.";
  }
  if (name.endsWith("/")) {
    return "Branch name can't end with '/'.";
  }
  if (name.endsWith(".")) {
    return "Branch name can't end with '.'.";
  }
  if (name === "@") {
    return "'@' is reserved.";
  }
  if (name.includes("..")) {
    return "Branch name can't contain '..'.";
  }
  if (name.includes("@{")) {
    return "Branch name can't contain '@{'.";
  }
  if (name.includes("//")) {
    return "Branch name can't contain '//'.";
  }
  for (const char of name) {
    if ((char.codePointAt(0) ?? 0) < 32 || char === "\u007F") {
      return "Branch name can't contain control characters.";
    }
    if (FORBIDDEN.includes(char)) {
      return "Branch name can't contain spaces or any of ~ ^ : ? * [ \\.";
    }
  }
  for (const part of name.split("/")) {
    const reason = badComponent(part);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
};
