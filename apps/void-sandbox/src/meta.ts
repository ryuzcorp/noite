/**
 * Bundle identity for the `noite-void-sandbox` controller (see SPEC.md "Void
 * sandbox controller"). The image build compiles these constants into
 * `dist/worker.js` and records them in `dist/meta.json`, which the runner
 * reads back at deploy time.
 *
 * `VOID_VERSION` must name the exact `void` npm version in `package.json`
 * (`docker/check-versions.ts` guards the agreement); the protocol check in
 * `protocol.ts` refuses any app whose `void` major differs from `VOID_MAJOR`.
 */

/** Exact `void` npm version this bundle builds against. */
export const VOID_VERSION = "1.5.0";

/** Major of `VOID_VERSION`, kept as a literal so drift fails loudly. */
export const VOID_MAJOR = 1;

/**
 * `invoke` vocabulary + wire shapes this bundle speaks. 2 is the only
 * protocol any current `void` emits.
 */
export const CONTROLLER_PROTOCOL = 2;

/** Runner-owned script name, one per Void fleet. */
export const CONTROLLER_SCRIPT_NAME = "noite-void-sandbox";

/** Default for `__VOID_SANDBOX_MAX_CONCURRENT` when the var is absent. */
export const DEFAULT_MAX_CONCURRENT = 4;
