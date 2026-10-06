import { RUNNER_DEFAULT_URL } from "../lib/runner";

/** Shape every entry in the route table dispatches to. */
export type RouteHandler = (
  request: Request,
  env: KitEnv,
  params?: Record<string, string | undefined>
) => Response | undefined | Promise<Response | undefined>;

/** Runner base URL + bearer token from the control env (undefined when
 * the token is missing). */
export const runnerConfig = (
  kit: KitEnv
): { runner: string; token: string } | undefined => {
  const token = kit.RUNNER_TOKEN ?? "";
  if (!token) {
    return undefined;
  }
  const runner = (kit.RUNNER_URL ?? RUNNER_DEFAULT_URL).replace(/\/$/u, "");
  return { runner, token };
};

export const runnerTokenOk = (request: Request, env: KitEnv): boolean => {
  const expected = env.RUNNER_TOKEN ?? "";
  if (!expected) {
    return false;
  }
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  const header =
    request.headers.get("x-runner-token") ??
    request.headers.get("x-host-token") ??
    "";
  return bearer === expected || header === expected;
};
