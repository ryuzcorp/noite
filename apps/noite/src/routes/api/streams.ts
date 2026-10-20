import { handleStreamHub } from "../../http/routes/stream-hub";
/** `GET /api/streams?t=<topic>…`: every live feed of a page on one
 * connection (timeout-exempt). */
import { route } from "../_adapter";

export const GET = route(handleStreamHub);
