import { handleLogsStream } from "../../../../../http/routes/streams";
/** `GET /api/apps/:appId/logs/stream` (timeout-exempt). */
import { route } from "../../../../_adapter";

export const GET = route(handleLogsStream);
