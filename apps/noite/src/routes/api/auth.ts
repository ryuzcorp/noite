import { handleAuth } from "../../http/routes/auth";
/**
 * `ALL /api/auth` (was `router.all("/api/auth")`): better-auth dispatches on
 * method itself, so every scanned method maps onto the mount. The `[...rest]`
 * sibling covers everything below this path.
 */
import { route } from "../_adapter";

export const DELETE = route(handleAuth);
export const GET = route(handleAuth);
export const HEAD = route(handleAuth);
export const OPTIONS = route(handleAuth);
export const PATCH = route(handleAuth);
export const POST = route(handleAuth);
export const PUT = route(handleAuth);
