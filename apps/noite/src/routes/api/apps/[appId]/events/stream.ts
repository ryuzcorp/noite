import { handleEventsStream } from "../../../../../http/routes/streams";
/** `GET /api/apps/:appId/events/stream` (timeout-exempt). */
import { route } from "../../../../_adapter";

export const GET = route(handleEventsStream);
