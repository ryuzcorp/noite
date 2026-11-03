/** Controller input contract (rendered by the runner; see SPEC.md "Void sandbox controller"). */
import type { NoiteSandboxAdmission } from "./admission.ts";
import type { SandboxController } from "./controller.ts";

/**
 * Controller environment. Bindings are required; vars are optional so a
 * missing value fails closed with the documented default instead of
 * crashing. SPEC.md marks which field each behavior requires.
 *
 * Security rule: the admission namespace is controller-internal. It is never
 * bound into the tenant app and its stubs never cross to it; the app reaches
 * exactly one `SANDBOX` cell stub per `getSandbox` call.
 */
export interface ControllerEnv {
  /** Sandbox cells, one per sandbox id. */
  readonly SANDBOX: DurableObjectNamespace<SandboxController>;
  /** Fleet-local admission counter. Controller-internal; never app-visible. */
  readonly __VOID_SANDBOX_ADMISSION: DurableObjectNamespace<NoiteSandboxAdmission>;
  /**
   * Secret name of the fleet's admission cell: at least 32 base64url
   * characters, minted once per fleet by the runner. Missing or short
   * fails every admission closed.
   */
  readonly __VOID_SANDBOX_ADMISSION_NAME?: string;
  /**
   * Max concurrent live sandboxes, parsed as an integer (default `"4"` when
   * the var is missing — the runner always renders it). `"0"` admits
   * nothing; a present-but-unreadable value fails closed to `0`.
   */
  readonly __VOID_SANDBOX_MAX_CONCURRENT?: string;
  /**
   * `void <version> / bundle sha256:<hex>` recorded at deploy. Debug only;
   * nothing reads it at runtime.
   */
  readonly __VOID_SANDBOX_SOURCE?: string;
}
