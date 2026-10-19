import { handleMetricsStream } from "../../../../../http/routes/streams";
/** `GET /api/apps/:appId/metrics/stream` (timeout-exempt). */
import { route } from "../../../../_adapter";

export const GET = route(handleMetricsStream);
