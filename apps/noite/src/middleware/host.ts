/**
 * Vite DEV: no Server Entry — durable bindings still needed for actions.
 */
import { installBunDurable } from "../lib/bun-durable";
import { controlEnv, hydrateControlEnv } from "../lib/control-env";

hydrateControlEnv();
installBunDurable(controlEnv);

export default async function host() {
  /* side-effect only — Bun host supervisor retired (Rust host plane). */
}
