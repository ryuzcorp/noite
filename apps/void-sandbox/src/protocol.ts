/**
 * App/controller protocol compatibility (see SPEC.md "Void sandbox
 * controller"). Void gates on the `controllerProtocol` its build stamps;
 * Noite has no deploy manifest to read, so the runner refuses before `celld
 * deploy` unless the app's `void` major matches the embedded bundle's. Minor
 * and patch drift inside one protocol are wire-compatible by Void's own rule.
 *
 * The runner (Rust) ports `assertCompatibleVoidVersion` verbatim, message
 * included; the tests here pin the rule and the wording.
 */
import { VOID_MAJOR, VOID_VERSION } from "./meta.ts";

/** Void's exact refusal (its deploy gate emits this string). */
export const VOID_UPGRADE_MESSAGE =
  "Managed Sandboxes require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.";

const RANGE_PREFIX = /^[v=^~><\s]+/u;
const MAJOR = /^(?<major>\d+)(?:\.|$)/u;

/**
 * Leading major of a version or range (`1.5.0`, `^1.2.0`, `>=1.0.0 <2.0.0`,
 * `v1.5.0`), or null when no major is readable. Anything unreadable refuses:
 * fail closed, never guess.
 */
export const parseVoidMajor = (spec: string): number | null => {
  const major = MAJOR.exec(spec.trim().replace(RANGE_PREFIX, ""))?.groups
    ?.major;

  if (major === undefined) {
    return null;
  }

  return Number(major);
};

/**
 * Throw `VOID_UPGRADE_MESSAGE` unless the app's `void` spec resolves to the
 * bundle's major. A missing or unreadable spec refuses.
 */
export const assertCompatibleVoidVersion = (
  appSpec?: string,
  bundleVersion: string = VOID_VERSION
): void => {
  const appMajor = appSpec === undefined ? null : parseVoidMajor(appSpec);

  if (appMajor === null || appMajor !== VOID_MAJOR) {
    throw new Error(VOID_UPGRADE_MESSAGE);
  }

  if (parseVoidMajor(bundleVersion) !== VOID_MAJOR) {
    throw new Error(
      `Sandbox controller bundle reports void ${bundleVersion} but pins major ${VOID_MAJOR}.`
    );
  }
};
