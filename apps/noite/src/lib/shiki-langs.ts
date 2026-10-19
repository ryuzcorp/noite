/** Curated highlight languages (resource opt T6.1): what tenant Worker repos
 * contain. Resolved shiki ids (note: `sh` resolves to `zsh`); `text` is built
 * into shiki and never imported as a module. Anything else renders as plain
 * text — no on-demand grammar download, no egress. Shared by the source
 * browser (which preloads them) and `vite.config.ts` (which stubs the rest). */
export const CURATED_SHIKI_LANGS: readonly string[] = [
  "css",
  "html",
  "javascript",
  "json",
  "jsonc",
  "jsx",
  "markdown",
  "sql",
  "text",
  "toml",
  "tsx",
  "typescript",
  "yaml",
  "zsh",
];

/** A filename's highlight language, capped to the curated set: anything else
 * renders as plain text (see above). */
export const curatedLang = (
  name: string,
  resolve: (filename: string) => string
): string => {
  const lang = resolve(name);

  return CURATED_SHIKI_LANGS.includes(lang) ? lang : "text";
};
