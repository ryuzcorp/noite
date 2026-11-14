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

const encoder = new TextEncoder();

/** Compares in time that depends only on the expected token's length, so
 * response timing on the public control host doesn't reveal how much of a
 * guessed runner token matched. */
export const tokenEquals = (given: string, expected: string): boolean => {
  const left = encoder.encode(given);
  const right = encoder.encode(expected);
  // oxlint-disable-next-line no-bitwise -- constant-time compare: no early exit on the first differing byte
  let diff = left.length ^ right.length;

  for (const [index, byte] of right.entries()) {
    // oxlint-disable-next-line no-bitwise -- constant-time compare: accumulate every byte's difference
    diff |= (left[index] ?? 0) ^ byte;
  }

  return diff === 0;
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

  // Both compared every time: no short-circuit on which header matched.
  const viaBearer = tokenEquals(bearer, expected);
  const viaHeader = tokenEquals(header, expected);

  return viaBearer || viaHeader;
};
