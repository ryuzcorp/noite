//! Reading a config file's literals without running it. A `cloudflare.config.ts`
//! is TypeScript that calls `defineWorker({ … })`; a `wrangler.jsonc` is JSON
//! with comments. Neither is executed here — the calls are matched, their
//! argument text is walked with a bracket matcher, and the plain data inside
//! (strings, numbers, booleans, arrays, objects) is read out. A call, an
//! identifier or a spread reads as `undefined`, and the caller decides what
//! that means.

/** A config literal: the plain data a builder is handed. */
export type LiteralValue =
  | LiteralObject
  | LiteralValue[]
  | boolean
  | null
  | number
  | string
  | undefined;

export interface LiteralObject {
  [key: string]: LiteralValue;
}

/** One call the scanner matched: `NAME: namespace.builder(…)`. */
export interface ScannedCall {
  /** The text between the call's parentheses. */
  argumentText: string;
  /** The method called (`d1`, `r2`, `durableObject`, …). */
  builder: string;
  /** The property the call is assigned to, when the match captured one. */
  name: string | null;
  /** What the call was made on (`bindings`, `exports`, …): a `bindings` call
   * fills `env`, an `exports` call declares a class. */
  namespace: string;
}

/** An import: the local name and the specifier it came from. */
export interface ImportedName {
  local: string;
  specifier: string;
}

export const isLiteralValue = (value: unknown): value is LiteralValue =>
  value === undefined ||
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string" ||
  (Array.isArray(value) && value.every(isLiteralValue)) ||
  (typeof value === "object" && Object.values(value).every(isLiteralValue));

const isKey = (value: string): boolean => /^[A-Za-z_$][\w$]*$/u.test(value);

/** A lookup by a name a config file wrote. */
interface TextTable {
  [name: string]: string;
}

/** The bracket a bracket closes, in a config's source text. */
const PAIRS: TextTable = { "(": ")", "[": "]", "{": "}" };

/** The escapes a config string uses. */
const ESCAPES: TextTable = { n: "\n", r: "\r", t: "\t" };

/** The values that write themselves in a config literal. */
const PLAIN: LiteralObject = { false: false, null: null, true: true };

/** The string literal starting at `index`, and the index just past it. */
const readString = (
  text: string,
  index: number
): { end: number; value: string } | null => {
  const quote = text[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  let value = "";
  for (let i = index + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      const escaped = text[i + 1];
      value += ESCAPES[escaped ?? ""] ?? escaped ?? char;
      i += 1;
      continue;
    }
    if (char === quote) {
      return { end: i + 1, value };
    }
    if (char === "\n" && quote !== "`") {
      return null;
    }
    value += char;
  }
  return null;
};

/** The index of the bracket matching the one at `open`, or -1. Strings and
 * comments inside are skipped, so a `)` in either does not end the scan. */
const matchBracket = (text: string, open: number): number => {
  const closing = PAIRS[text[open]];
  if (closing === undefined) {
    return -1;
  }
  const stack = [closing];
  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      const read = readString(text, i);
      if (read === null) {
        return -1;
      }
      i = read.end - 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    const pair = PAIRS[char];
    if (pair !== undefined) {
      stack.push(pair);
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return i;
      }
    }
  }
  return -1;
};

/** `{ a: 1, b: { c: 2 } }`'s entries: commas at depth 0 only. */
const splitTopLevel = (source: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      const read = readString(source, i);
      if (read === null) {
        break;
      }
      i = read.end - 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  const last = source.slice(start);
  if (last.trim() !== "") {
    parts.push(last);
  }
  return parts;
};

/** The index of the `:` that separates a key from its value in one entry —
 * -1 for a shorthand property or a spread. */
const colonIndex = (entry: string): number => {
  let depth = 0;
  for (let i = 0; i < entry.length; i += 1) {
    const char = entry[i];
    if (char === '"' || char === "'" || char === "`") {
      const read = readString(entry, i);
      if (read === null) {
        return -1;
      }
      i = read.end - 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      continue;
    }
    if (char === ":" && depth === 0) {
      return i;
    }
  }
  return -1;
};

/** A literal object's key: the text before its colon, when it names one. */
const keyOf = (text: string): string | null => {
  const raw = text.trim();
  return readString(raw, 0)?.value ?? (isKey(raw) ? raw : null);
};

/** A literal's value, from its source text. */
export const literalOf = (text: string): LiteralValue => {
  const source = text.trim();
  const [first] = source;
  if (first === undefined) {
    return undefined;
  }
  if (first === '"' || first === "'" || first === "`") {
    return readString(source, 0)?.value;
  }
  // `Object.hasOwn`, not a plain read: a literal of `constructor` must read as
  // the identifier it is, not as a property of `Object.prototype`.
  if (Object.hasOwn(PLAIN, source)) {
    return PLAIN[source];
  }
  if (first === "-" || /\d/u.test(first)) {
    const value = Number(source);
    return Number.isNaN(value) ? undefined : value;
  }
  if (first !== "[" && first !== "{") {
    return undefined;
  }
  if (matchBracket(source, 0) !== source.length - 1) {
    return undefined;
  }
  const inner = source.slice(1, -1);
  if (first === "[") {
    return splitTopLevel(inner).map((part) => literalOf(part));
  }
  const entries: LiteralObject = {};
  for (const part of splitTopLevel(inner)) {
    const colon = colonIndex(part);
    if (colon === -1) {
      continue;
    }
    const key = keyOf(part.slice(0, colon));
    if (key !== null) {
      entries[key] = literalOf(part.slice(colon + 1));
    }
  }
  return entries;
};

/** The argument text of the first `<name>(…)` call in `text`. */
export const callArguments = (text: string, name: string): string | null => {
  const at = text.indexOf(`${name}(`);
  if (at === -1) {
    return null;
  }
  const open = at + name.length;
  const close = matchBracket(text, open);
  return close === -1 ? null : text.slice(open + 1, close);
};

/** Every match of `pattern` that ends on an opening parenthesis, with the
 * call's arguments and the `name`/`builder` groups the pattern captured. */
export const scanCalls = (text: string, pattern: RegExp): ScannedCall[] => {
  const calls: ScannedCall[] = [];
  for (const match of text.matchAll(pattern)) {
    const { builder, name = null, namespace } = match.groups ?? {};
    if (builder === undefined || namespace === undefined) {
      continue;
    }
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchBracket(text, open);
    if (close !== -1) {
      calls.push({
        argumentText: text.slice(open + 1, close),
        builder,
        name,
        namespace,
      });
    }
  }
  return calls;
};

/** The imports of a module, from its `import` statements: the local name and
 * the specifier. `import * as ns from "x"`, `import ns from "x"` and named
 * imports all land here; a bare `import "x"` has no local name and is left
 * out. */
export const findImports = (text: string): ImportedName[] => {
  const imports: ImportedName[] = [];
  const namespace =
    /import\s+\*\s+as\s+(?<local>[\w$]+)\s+from\s+(?<specifier>["'][^"']+["'])/gu;
  const plain =
    /import\s+(?<local>[\w$]+)\s+from\s+(?<specifier>["'][^"']+["'])/gu;
  for (const pattern of [namespace, plain]) {
    for (const match of text.matchAll(pattern)) {
      const { local, specifier } = match.groups ?? {};
      if (local !== undefined && specifier !== undefined) {
        imports.push({
          local,
          specifier: readString(specifier, 0)?.value ?? "",
        });
      }
    }
  }
  return imports;
};

/** JSON with its line and block comments and its trailing commas removed. A
 * marker inside a string is left alone. */
const stripJsonc = (text: string): string => {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += char;
  }
  return out.replaceAll(/,\s*(?=[}\]])/gu, "");
};

/** A JSON-ish file's text as the shape `is` accepts: the file itself, or the
 * file with its comments and trailing commas removed — what `wrangler.jsonc`
 * is in practice. `null` when neither parses, and when the parse does not
 * hold the shape. */
export const parseJsonFile = <T>(
  text: string,
  is: (value: unknown) => value is T
): T | null => {
  for (const attempt of [text, stripJsonc(text)]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    return is(parsed) ? parsed : null;
  }
  return null;
};
