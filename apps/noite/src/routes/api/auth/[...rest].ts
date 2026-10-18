import { handleAuth } from "../../../http/routes/auth";
/**
 * `ALL /api/auth/*` (was `router.all("/api/auth/*")`): better-auth reads the
 * full request URL, so the catch-all remainder needs no param lookup here.
 */
import { route } from "../../_adapter";

export const DELETE = route(handleAuth);
export const GET = route(handleAuth);
export const HEAD = route(handleAuth);
export const OPTIONS = route(handleAuth);
export const PATCH = route(handleAuth);
export const POST = route(handleAuth);
export const PUT = route(handleAuth);
