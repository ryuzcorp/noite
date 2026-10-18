import { handleR2Raw } from "../../../../../http/routes/r2";
/** `GET /storage/:appId/r2/:bucket/raw`. */
import { route } from "../../../../_adapter";

export const GET = route(handleR2Raw);
