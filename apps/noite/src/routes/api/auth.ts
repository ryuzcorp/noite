import { handleAuth } from "../../http/routes/auth";
/**
 * `ALL /api/auth` minus HEAD (was `router.all("/api/auth")`): better-auth
 * dispatches on method itself, so every other scanned method maps onto the
 * mount. No `HEAD` export: Void's generator emits `app.head(...)` for it,
 * which Hono lacks — and Hono serves HEAD from the GET route anyway. The
 * `[...rest]` sibling covers everything below this path.
 */
import { route } from "../_adapter";

export const DELETE = route(handleAuth);
export const GET = route(handleAuth);
export const OPTIONS = route(handleAuth);
export const PATCH = route(handleAuth);
export const POST = route(handleAuth);
export const PUT = route(handleAuth);
