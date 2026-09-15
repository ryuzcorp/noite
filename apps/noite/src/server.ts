import type { ServerEntry } from "oxidejs";

import { handleHttp } from "./http/routes";
import { installBunDurable } from "./lib/bun-durable";
import { controlEnv, hydrateControlEnv } from "./lib/control-env";

hydrateControlEnv();
installBunDurable(controlEnv);

export const fetch = handleHttp;

export default { fetch } satisfies ServerEntry<KitEnv>;
