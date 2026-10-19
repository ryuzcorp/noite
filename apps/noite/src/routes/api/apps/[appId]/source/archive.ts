import { handleSourceArchive } from "../../../../../http/routes/source";
/** `GET /api/apps/:appId/source/archive` (timeout-exempt tar download). */
import { route } from "../../../../_adapter";

export const GET = route(handleSourceArchive);
