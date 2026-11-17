/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a partial Hono context stands in for the Worker request context */
//! Minimal Hono contexts for driving Void route/middleware handlers in unit
//! tests: the real `Request`, the test env, URL params, and `c.json`. The
//! handlers under test only touch these members; the rest of `CloudContext`
//! stays stubbed.
import type { CloudContext } from "void";

/** JSON error bodies the stubbed `c.json` answers with. */
export interface TestJsonError {
  error: string;
}

/** Drive a `defineHandler` route with a real request and URL params. */
export const testRouteContext = (
  request: Request,
  env: KitEnv,
  params: Record<string, string> = {}
): CloudContext => {
  // The per-request variable store stands in for Hono's: today the timeout
  // middleware is the only writer and it stamps an AbortSignal, so the map
  // is typed for exactly that.
  const vars = new Map<string, AbortSignal>();

  return {
    env,
    get: (key: string): AbortSignal | undefined => vars.get(key),
    json: (data: TestJsonError, status?: number): Response =>
      Response.json(data, status === undefined ? undefined : { status }),
    req: {
      param: (name?: string): Record<string, string> | string | undefined =>
        name === undefined ? params : params[name],
      path: new URL(request.url).pathname,
      raw: request,
    },
    set: (key: string, value: AbortSignal): void => {
      vars.set(key, value);
    },
  } as unknown as CloudContext;
};
