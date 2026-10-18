import { handleInviteStatus } from "../../../http/routes/auth";
/** `GET /api/invite/status`. */
import { route } from "../../_adapter";

export const GET = route(handleInviteStatus);
