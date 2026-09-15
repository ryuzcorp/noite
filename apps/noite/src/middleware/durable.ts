import { ensureDurableEnv, installBunDurable } from "../lib/bun-durable";
import { controlEnv } from "../lib/control-env";

installBunDurable(controlEnv);

/** Ensure request env has workflow/queue bindings. */
export default function durable(_request: Request, context: { env: unknown }) {
  // SAFETY: oxide/bun hands middleware a plain env object when bound; an object check distinguishes it from primitive/absent env.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (context.env && typeof context.env === "object") {
    // SAFETY: the env bag mirrors the shared controlEnv shape (strings + durable bindings), so widening to a Record for hydration is safe.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
    ensureDurableEnv(context.env as Record<string, unknown>);
  }
}
