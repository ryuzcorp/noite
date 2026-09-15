import type { ServerEntry } from "oxidejs";

import { handleHttp } from "./http/routes";
import { installBunDurable } from "./lib/bun-durable";
import { controlEnv, hydrateControlEnv } from "./lib/control-env";

hydrateControlEnv();
installBunDurable(controlEnv);

// NOTE: no named `fetch` export on purpose. Oxide builds the full app
// (middleware + SSR + static) as the default export; srvx-style loaders
// prefer a named `fetch` and would serve the raw API-only `handleHttp`,
// 404ing every page. Keep the entry surface to the composed app.
export default { fetch: handleHttp } satisfies ServerEntry<KitEnv>;
