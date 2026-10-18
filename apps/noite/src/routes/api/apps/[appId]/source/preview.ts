import { handleSourcePreview } from "../../../../../http/routes/source";
/** `POST /api/apps/:appId/source/preview`. */
import { route } from "../../../../_adapter";

export const POST = route(handleSourcePreview);
