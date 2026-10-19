//! The `.gitignore` matcher: the exclude rules a checkout carries, compiled
//! and applied the way git applies them. The walk that lists the checkout reads
//! every `.gitignore` it passes — the root's first, a nested one's rules
//! layered over its parents' — and asks this module about each path; what it
//! excludes is what the tree paints dimmed and the Changes panel never counts.
//! Nothing here touches the pod (it is a parser and one verdict), and the
//! `committed` answer is a parameter because git's rules are not the whole
//! story: git keeps tracking what it has committed, whatever a `.gitignore`
//! says about it, and only the caller holds the commit.

/** The file the rules come from: git's own name for them, at the checkout's
 * root and in any directory under it. */
export const IGNORE_FILE = ".gitignore";

/** The folder a Noite checkout always excludes, whatever a `.gitignore` says:
 * installed dependencies (`npm install` run in the Terminal) live in the
 * checkout but are never part of it — Nodepod does not persist them either —
 * and it is the one folder a walk must not descend into (see the walk in
 * `./workspace/changes`). A `!node_modules` rule cannot bring it back, and git
 * cannot either; a commit that really holds files under it does, because a
 * committed path is never excluded (see `isIgnored`) — otherwise those files
 * would go on being tracked while nothing showed or pushed them. */
const DEPENDENCY_DIR = "node_modules";

/** One compiled pattern. */
interface Rule {
  /** The checkout-relative directory the `.gitignore` holding it sits in (`""`
   * for the checkout root): the pattern reads paths relative to it. */
  base: string;
  /** A pattern ending in `/` only ever matches a directory. */
  dirOnly: boolean;
  /** A `!` pattern re-includes what an earlier one excluded. */
  negated: boolean;
  /** The compiled pattern, matched against a path relative to `base`. */
  re: RegExp;
}

/** The rules that hold in one directory: the ones inherited from above first,
 * then the ones its own `.gitignore` adds — the last pattern that matches a
 * path decides, so a deeper file wins. */
export type IgnoreRules = readonly Rule[];

/** No rules at all: what the walk starts from at the checkout root. */
export const NO_RULES: IgnoreRules = [];

/** Whether a path is one git already tracks. The matcher cannot know (the
 * commit is the caller's), and a committed path is never excluded — neither is
 * a directory that holds one, because dropping it would drop the committed
 * file off the tree with it. */
export type Committed = (path: string, isDir: boolean) => boolean;

/** The characters a pattern's own text cannot be taken for: everything else is
 * a literal, and these are escaped to read as one. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/gu;

const literal = (text: string): string =>
  text.replaceAll(REGEX_METACHARACTERS, "\\$&");

/** Where a `[...]` class ends, looking from `start` (the index after the
 * bracket, or after its `!`): a `]` right at the start is one of its members,
 * and a `[[:alpha:]]`-style class nested in it keeps its own brackets. -1 when
 * the class is never closed. */
const classEnd = (segment: string, start: number): number => {
  for (
    let i = segment.charAt(start) === "]" ? start + 1 : start;
    i < segment.length;
    i += 1
  ) {
    if (segment.charAt(i) === "[" && segment.charAt(i + 1) === ":") {
      const posix = segment.indexOf(":]", i + 2);

      if (posix !== -1) {
        i = posix + 1;
        continue;
      }
    }

    if (segment.charAt(i) === "]") {
      return i;
    }
  }

  return -1;
};

/** The character classes git's matcher knows and a regex does not: a `[...]`
 * can name one as `[:alpha:]`, and this is what each stands for. */
const POSIX_CLASSES = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e",
  space: "\\s",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
} satisfies Record<string, string>;

/** A class body as a regex source: a `[:alpha:]` named class becomes what it
 * stands for, a `-` keeps its ranges, and every other character is escaped (an
 * escape a plain character does not need is still a legal one in a class). */
const classSource = (body: string): string => {
  let source = "";

  for (let i = 0; i < body.length; i += 1) {
    const char = body.charAt(i);

    if (char === "[" && body.charAt(i + 1) === ":") {
      const end = body.indexOf(":]", i + 2);
      const name = end === -1 ? "" : body.slice(i + 2, end);

      const named = Object.entries(POSIX_CLASSES).find(
        ([key]) => key === name
      )?.[1];

      if (named !== undefined) {
        source += named;
        i = end + 1;
        continue;
      }
    }

    source += char === "-" ? char : literal(char);
  }

  return source;
};

/** One path segment of a pattern as a regex source: `*` and `?` stop at a
 * segment's end (a segment holds no `/`), a `[...]` class keeps git's own `!`
 * negation, and a backslash makes the character after it literal. */
const segmentSource = (segment: string): string => {
  let source = "";

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment.charAt(i);

    if (char === "\\") {
      const next = segment.charAt(i + 1);
      source += next === "" ? "\\\\" : literal(next);

      if (next !== "") {
        i += 1;
      }

      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "[") {
      const invert =
        segment.charAt(i + 1) === "!" || segment.charAt(i + 1) === "^";

      const start = invert ? i + 2 : i + 1;
      const close = classEnd(segment, start);

      if (close === -1) {
        source += "\\[";
        continue;
      }

      source += `[${invert ? "^" : ""}${classSource(segment.slice(start, close))}]`;
      i = close;
      continue;
    }

    source += literal(char);
  }

  return source;
};

/** A whole pattern as a regex source. `**` is git's own token: as a segment of
 * a longer pattern it reaches across directories (zero of them, too), at the
 * end it takes everything inside the directory before it, and anywhere else it
 * is no different from two `*`. */
const patternSource = (pattern: string): string => {
  const segments = pattern.split("/");
  let source = "";

  for (const [index, segment] of segments.entries()) {
    if (segment === "**" && segments.length > 1) {
      source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
      continue;
    }

    source += segmentSource(segment);

    if (index < segments.length - 1) {
      source += "/";
    }
  }

  return source;
};

/** What a rule that cannot be carried by a regex answers instead: a class git
 * reads as a set (`[z-a]`, say) can be one no regex accepts, and a bad line in
 * a `.gitignore` must not take the whole tree and change list down with it —
 * a rule that matches nothing at least hides nothing. */
const NEVER_MATCHES = /(?!)/u;

/** The one pattern, anchored or at any depth, as the regex a path is tested
 * against. */
const compiled = (body: string, anchored: boolean): RegExp => {
  try {
    return new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`, "u");
  } catch {
    return NEVER_MATCHES;
  }
};

/** One line of a `.gitignore` compiled, or null for the lines that are not
 * patterns: a blank one, and a `#` comment (a backslash escapes both the `#`
 * and a leading `!`, and trailing spaces are not part of a pattern unless they
 * are escaped). */
const compile = (line: string, base: string): Rule | null => {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  let end = trimmed.length;

  while (end > 0 && trimmed[end - 1] === " " && trimmed[end - 2] !== "\\") {
    end -= 1;
  }

  let text = trimmed.slice(0, end);

  if (text === "" || text.startsWith("#")) {
    return null;
  }

  let negated = false;

  if (text.startsWith("!")) {
    negated = true;
    text = text.slice(1);
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) {
    text = text.slice(1);
  }

  const dirOnly = text.endsWith("/");

  if (dirOnly) {
    text = text.slice(0, -1);
  }

  // A separator anywhere but the end anchors the pattern to the `.gitignore`'s
  // own directory; without one it matches at any depth below it.
  const anchored = text.startsWith("/") || text.includes("/");

  if (text.startsWith("/")) {
    text = text.slice(1);
  }

  if (text === "") {
    return null;
  }

  const body = patternSource(text);

  return {
    base,
    dirOnly,
    negated,
    re: compiled(body, anchored),
  };
};

/** `text` (one `.gitignore`, read from `base`, the checkout-relative directory
 * that holds it — `""` at the root) added to the rules that already hold
 * there. */
export const addIgnoreFile = (
  rules: IgnoreRules,
  text: string,
  base: string
): IgnoreRules => {
  const added: Rule[] = [];

  for (const line of text.split("\n")) {
    const rule = compile(line, base);

    if (rule !== null) {
      added.push(rule);
    }
  }

  return added.length === 0 ? rules : [...rules, ...added];
};

/** Exactly one path's verdict: the rules are tried last-first, and the first
 * one that matches decides — a `!` rule matches the same way and answers that
 * the path is kept. A rule reads paths relative to the directory of the
 * `.gitignore` it came from, and only reaches what is under it. */
const decides = (rules: IgnoreRules, path: string, isDir: boolean): boolean => {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];

    if (rule === undefined || (rule.dirOnly && !isDir)) {
      continue;
    }

    // A rule of a nested `.gitignore` reads paths from its own directory, and
    // only reaches what sits under it.
    if (rule.base !== "" && !path.startsWith(`${rule.base}/`)) {
      continue;
    }

    const rel = rule.base === "" ? path : path.slice(rule.base.length + 1);

    if (rule.re.test(rel)) {
      return !rule.negated;
    }
  }

  return false;
};

/** Whether the rules exclude `path`: itself, or any directory above it — git
 * never looks inside an excluded directory ("it is not possible to re-include
 * a file if a parent directory of that file is excluded"), so a rule on a
 * folder excludes everything under it and no `!` below can bring it back. The
 * dependency folder is excluded whatever the rules say, and a committed path is
 * never excluded at all. `path` is checkout-relative, with no leading slash and
 * no trailing one. */
export const isIgnored = (
  rules: IgnoreRules,
  path: string,
  isDir: boolean,
  committed: Committed = () => false
): boolean => {
  if (committed(path, isDir)) {
    return false;
  }

  const parts = path.split("/");

  if (parts.includes(DEPENDENCY_DIR)) {
    return true;
  }

  for (let i = 1; i < parts.length; i += 1) {
    if (decides(rules, parts.slice(0, i).join("/"), true)) {
      return true;
    }
  }

  return decides(rules, path, isDir);
};
