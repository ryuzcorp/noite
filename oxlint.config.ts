import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  // ts-rs bindings are generated (apps/runner -> src/lib/runner-types) and
  // checked for drift in CI; reformatting them would fight the generator.
  ignorePatterns: [
    ...core.ignorePatterns,
    "apps/noite/src/lib/runner-types/**",
  ],
  overrides: [
    {
      // Void file-based routing: the filename IS the endpoint path
      // (action-verbatim camelCase for the JSON-action endpoints), and the
      // route scanner only detects literal `export const POST` declarators —
      // never `export … from` re-exports.
      files: ["apps/noite/src/routes/api/**/*.ts"],
      rules: {
        "unicorn/filename-case": "off",
        "unicorn/prefer-export-from": "off",
      },
    },
  ],
});
