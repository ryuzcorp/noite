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
});
