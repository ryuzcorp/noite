/**
 * Noite Void-sandbox controller entry (celld `main`).
 *
 * One runner-owned script, `noite-void-sandbox`, cohosted in each Void app's
 * fleet next to the tenant app (celld `services` resolve within the fleet
 * bucket only, so one fleet's controller is unreachable from any other fleet
 * or from the public internet). The tenant app reaches it solely through its
 * in-fleet `__VOID_SANDBOX` service binding.
 *
 * Deploy: the image build compiles this file plus `src/` into the fixed
 * `dist/worker.js` bundle (`bun ./build.ts`, from the pinned `void` npm
 * version); S3 embeds that bundle and renders the `Env` vars documented in
 * SPEC.md ("Void sandbox controller"). Tests, test helpers and `workers.d.ts`
 * never ship; neither does `build.ts`.
 *
 * Shape: `getSandbox` returns the controller cell's DO stub directly (the
 * DO-stub shape). Void's client only ever calls `capability.invoke(op, args)`
 * on it, so no Worker-held capability wrapper is needed — and none of the
 * admission plumbing (which lives behind `__VOID_SANDBOX_ADMISSION`, bound
 * only here) is reachable from the app.
 *
 * `getSandbox`'s validation is ported from Void's
 * `platform/packages/api/src/sandbox-controller-runtime.ts` (MIT License —
 * see the attribution note in SPEC.md "Void sandbox controller"); returning
 * the raw stub instead of a `SandboxCapability` is the Noite adaptation.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { validateSandboxOptions } from "void/_sandbox-container";
import type { SandboxOptions } from "void/_sandbox-container";

import type { SandboxController } from "./src/controller.ts";
import type { ControllerEnv } from "./src/env.ts";

export { NoiteSandboxAdmission } from "./src/admission.ts";

export { SandboxController } from "./src/controller.ts";

const MAX_SANDBOX_ID_LENGTH = 63;

export default class SandboxService extends WorkerEntrypoint<ControllerEnv> {
  /**
   * Resolve (and configure) the sandbox cell, handing the caller its stub.
   * The stub's `invoke` is the whole client contract; the admission binding,
   * namespaces and storage stay behind this service.
   */
  async getSandbox(
    id: string,
    options: SandboxOptions = {}
  ): Promise<DurableObjectStub<SandboxController>> {
    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- service args arrive untyped over RPC; the wire type is re-established here.
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_SANDBOX_ID_LENGTH
    ) {
      throw new TypeError(
        "Sandbox id must contain between 1 and 63 characters."
      );
    }

    validateSandboxOptions(options);
    const stub = this.env.SANDBOX.getByName(id);
    await stub.configure(options);

    return stub;
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- the entry fetch is a fixed 404 by design; nothing routes here.
  override fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
}
