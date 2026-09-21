/**
 * Stamp the Worker D1 binding, then ensure the schema before actions / auth.
 */
import type { D1Database } from "@cloudflare/workers-types";

import { ensureDbPromise, setD1Binding } from "../lib/db";

export default async function db(_request: Request, context: { env?: KitEnv }) {
  // SAFETY: DB is the D1 binding declared in wrangler.jsonc; middleware only stamps it when the platform injected a real binding.
  const d1 = context.env?.DB as D1Database | undefined;
  if (d1) {
    setD1Binding(d1);
  }
  await ensureDbPromise();
}
