import { handleSourceCommit } from "../../../../../http/routes/source";
/** `POST /api/apps/:appId/source/commit`. */
import { route } from "../../../../_adapter";

export const POST = route(handleSourceCommit);
