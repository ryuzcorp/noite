import { handleMcp } from "../http/routes/mcp";
/**
 * `ALL /mcp` minus HEAD (was `router.all("/mcp")`): the handler dispatches
 * on method itself (non-POST answers 405), so every other scanned method
 * maps onto it. No `HEAD` export: Void's generator emits `app.head(...)`
 * for it, which Hono lacks — and Hono serves HEAD from the GET route anyway.
 */
import { route } from "./_adapter";

export const DELETE = route(handleMcp);
export const GET = route(handleMcp);
export const OPTIONS = route(handleMcp);
export const PATCH = route(handleMcp);
export const POST = route(handleMcp);
export const PUT = route(handleMcp);
