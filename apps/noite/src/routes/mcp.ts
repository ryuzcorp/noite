import { handleMcp } from "../http/routes/mcp";
/**
 * `ALL /mcp` (was `router.all("/mcp")`): the handler dispatches on method
 * itself (non-POST answers 405), so every scanned method maps onto it.
 */
import { route } from "./_adapter";

export const DELETE = route(handleMcp);
export const GET = route(handleMcp);
export const HEAD = route(handleMcp);
export const OPTIONS = route(handleMcp);
export const PATCH = route(handleMcp);
export const POST = route(handleMcp);
export const PUT = route(handleMcp);
