import { handleTelemetryFacts } from "../../http/routes/internal";
/** `GET /internal/telemetry-facts` (was `router.on("GET", …)`). */
import { route } from "../_adapter";

export const GET = route(handleTelemetryFacts);
