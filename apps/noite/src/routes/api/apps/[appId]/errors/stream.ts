import { handleErrorsStream } from "../../../../../http/routes/streams";
/** `GET /api/apps/:appId/errors/stream` (timeout-exempt). */
import { route } from "../../../../_adapter";

export const GET = route(handleErrorsStream);
