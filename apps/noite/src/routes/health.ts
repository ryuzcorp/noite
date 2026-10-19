import { handleHealth } from "../http/routes/health";
/** `GET /health` (was `router.all("/health")`). No `HEAD` export: Void's
 * generator emits `app.head(...)` for it, which Hono lacks (its `METHODS`
 * has no `head`), crashing the worker at bootstrap — and Hono serves HEAD
 * from the GET route anyway. */
import { route } from "./_adapter";

export const GET = route(handleHealth);
