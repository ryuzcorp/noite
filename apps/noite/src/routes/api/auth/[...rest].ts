import { handleAuth } from "../../../http/routes/auth";
/**
 * `ALL /api/auth/*` minus HEAD (was `router.all("/api/auth/*")`):
 * better-auth reads the full request URL, so the catch-all remainder needs
 * no param lookup here. No `HEAD` export: Void's generator emits
 * `app.head(...)` for it, which Hono lacks — and Hono serves HEAD from the
 * GET route anyway.
 */
import { route } from "../../_adapter";

export const DELETE = route(handleAuth);
export const GET = route(handleAuth);
export const OPTIONS = route(handleAuth);
export const PATCH = route(handleAuth);
export const POST = route(handleAuth);
export const PUT = route(handleAuth);
