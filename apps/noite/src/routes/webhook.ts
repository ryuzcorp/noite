import { handleWebhook } from "../http/routes/internal";
/** `POST /webhook` (was `router.on("POST", "/webhook")`). */
import { route } from "./_adapter";

export const POST = route(handleWebhook);
