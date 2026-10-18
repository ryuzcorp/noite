import { handleHealth } from "../http/routes/health";
/** `GET|HEAD /health` (was `router.all("/health")`). */
import { route } from "./_adapter";

export const GET = route(handleHealth);
export const HEAD = route(handleHealth);
