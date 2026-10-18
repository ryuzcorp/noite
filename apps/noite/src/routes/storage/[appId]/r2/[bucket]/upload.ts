import { handleR2Upload } from "../../../../../http/routes/r2";
/** `PUT /storage/:appId/r2/:bucket/upload`. */
import { route } from "../../../../_adapter";

export const PUT = route(handleR2Upload);
