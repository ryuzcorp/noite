/**
 * Oxide server entry: plain HTTP routes (health, webhook, better-auth, SSE
 * proxies, ingest, R2 downloads). Runs after middleware and actions; an
 * unmatched path returns undefined and falls through to static assets.
 *
 * Default export only: `virtual:oxide/worker` re-exports this module's named
 * exports from the Worker, so route helpers stay in `http/router.ts`.
 */
import type { ServerEntry } from "oxidejs";

import { handleHttp } from "./http/router";

export default { fetch: handleHttp } satisfies ServerEntry<KitEnv>;
