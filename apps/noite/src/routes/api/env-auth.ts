import { handleEnvAuth } from "../../http/routes/env-auth";
/** `GET /api/env-auth` (the runner edge's members-only hand-off). */
import { route } from "../_adapter";

export const GET = route(handleEnvAuth);
