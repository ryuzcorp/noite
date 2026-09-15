/**
 * Oxide Vite DEV does not mount Server Entry — only middleware + actions.
 * Mirror health / webhook / Better Auth here so passkeys work under `vite`.
 */
import { handleHttp } from "../http/routes";

export default function apiRoutes(request: Request, context: { env?: KitEnv }) {
  // SAFETY: under `vite` no middleware env is injected, so process.env is the honest provider of the control env keys KitEnv narrows onto.
  return handleHttp(request, context.env ?? (process.env as KitEnv));
}
