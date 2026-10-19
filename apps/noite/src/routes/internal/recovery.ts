import { handleRecovery } from "../../http/routes/internal";
/** `POST /internal/recovery` (was `router.on("POST", "/internal/recovery")`). */
import { route } from "../_adapter";

export const POST = route(handleRecovery);
