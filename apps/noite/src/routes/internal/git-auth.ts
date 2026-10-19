import { handleGitAuth } from "../../http/routes/internal";
/** `POST /internal/git-auth` (was `router.on("POST", "/internal/git-auth")`). */
import { route } from "../_adapter";

export const POST = route(handleGitAuth);
