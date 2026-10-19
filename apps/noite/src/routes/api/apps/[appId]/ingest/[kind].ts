import { forwardIngest } from "../../../../../http/routes/ingest";
/** `POST /api/apps/:appId/ingest/:kind`. */
import { route } from "../../../../_adapter";

export const POST = route(forwardIngest);
