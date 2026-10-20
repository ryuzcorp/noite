import { handleAppStateStream } from "../../../../../http/routes/streams";
/** `GET /api/apps/:appId/state/stream` (timeout-exempt). */
import { route } from "../../../../_adapter";

export const GET = route(handleAppStateStream);
