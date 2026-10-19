import { handleDeploysStream } from "../../../../../http/routes/streams";
/** `GET /api/apps/:appId/deploys/stream` (timeout-exempt). */
import { route } from "../../../../_adapter";

export const GET = route(handleDeploysStream);
