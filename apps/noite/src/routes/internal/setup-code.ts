import { handleSetupCode } from "../../http/routes/internal";
/** `POST /internal/setup-code` (was `router.on("POST", "/internal/setup-code")`). */
import { route } from "../_adapter";

export const POST = route(handleSetupCode);
