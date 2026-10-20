import { handleEnvelope } from "../../../http/routes/envelope";
/** Browser-error envelope ingest (`POST :projectId/envelope`, plus the
 * Sentry SDK preflight as OPTIONS). */
import { route } from "../../_adapter";

export const POST = route(handleEnvelope);

export const OPTIONS = route(handleEnvelope);
