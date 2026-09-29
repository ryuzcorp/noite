import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Blume's `:::type` callouts: oxfmt joins a directive's lines into one,
  // and Blume then drops the whole callout from the page.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "**/*.mdx"],
});
