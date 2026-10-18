import { handleAppsStream } from "../../../http/routes/streams";
/** `GET /api/apps/stream` (timeout-exempt; the static sibling of `:appId`). */
import { route } from "../../_adapter";

export const GET = route(handleAppsStream);
