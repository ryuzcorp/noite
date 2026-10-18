/**
 * Server entry: plain HTTP routes (health, webhook, better-auth, SSE
 * proxies, ingest, R2 downloads). The Void worker entry calls the fetch
 * handler (routes slice); an unmatched path returns undefined and falls
 * through to static assets.
 *
 * Default export only, so route helpers stay in `http/router.ts`.
 */
import { handleHttp } from "./http/router";
/** Worker server entry (was oxidejs `ServerEntry`): the fetch handler. */
interface ServerEntry<E> {
  fetch: (
    request: Request,
    env: E
  ) => Response | undefined | Promise<Response | undefined>;
}

export default { fetch: handleHttp } satisfies ServerEntry<KitEnv>;
