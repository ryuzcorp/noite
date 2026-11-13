/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
//! Test-only stand-in for the Rust runner's REST API: installs a `fetch` that
//! answers `/v1/...` calls from an in-memory app table and records which
//! routes were called.
import type { Json } from "effect/Schema";

import { controlEnv } from "../lib/control-env";
import type { RunnerApp } from "../lib/runner";

export const makeApp = (over: Partial<RunnerApp> = {}): RunnerApp => ({
  asleepSince: null,
  autoDeploy: { state: "eligible" },
  createdAt: "2026-01-01T00:00:00Z",
  desiredState: "running",
  fleetBucket: "",
  gitPrefix: "",
  id: "app-1",
  imported: false,
  internalPort: null,
  lastDeploySha: null,
  lastError: null,
  listenPort: null,
  name: "App One",
  slug: "app-one",
  status: "running",
  subdomain: "app-one.noite.localhost",
  updatedAt: "2026-01-01T00:00:00Z",
  userId: "u-creator",
  wokeAt: null,
  ...over,
});

export interface RunnerMock {
  apps: RunnerApp[];
  /** Every route the double answered, as `"<METHOD> <path>"` (no query). */
  calls: string[];
  /** The params of every recorded call, in order (mirrors `calls`): the JSON
   * body when the call sent one, else the query string's fields. */
  requests: Record<string, Json>[];
  restore: () => void;
}

/** One call as the double sees it: the route plus its params and raw query. */
export interface MockCall {
  method: string;
  path: string;
  params: Record<string, Json>;
  query: URLSearchParams;
}

export interface RunnerMockOptions {
  /** Answers the routes this double does not model (pull requests, git,
   * deploys, environments, …). Return a `MockRefusal` to refuse like the
   * runner would; `undefined`/`null` answers the runner's 404. */
  resolve?: (call: MockCall) => Json | MockRefusal | undefined;
  /** Runs before the canned app-create answer. Return `"timeout"` to make
   * the call abort the way `AbortSignal.timeout` does when the runner
   * outlives the control plane's bound — the test can push the row it landed
   * onto `mock.apps` first, exactly the detached-create case. */
  onCreate?: (
    mock: RunnerMock,
    body: Record<string, string>
  ) => "timeout" | undefined;
}

/** A refusal the runner would answer with (e.g. a slug conflict): a status
 * and the plain-text message the control UI reads. A test can return one
 * from `resolve` to refuse like the runner would. */
export class MockRefusal {
  readonly message: string;
  readonly status: number;

  constructor(status: number, message: string) {
    this.status = status;
    this.message = message;
  }
}

/** The runner's answer for a row that does not exist. */
const notFound = (): Response => new Response("not found", { status: 404 });

/** One app route's remainder: `""` for the app itself. */
const APP_ROUTE = /^\/v1\/apps\/(?<id>[^/]+)(?<rest>\/.*)?$/u;

const BY_SLUG_PREFIX = "/v1/apps/by-slug/";

/** A JSON answer with the runner's status. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a test double serializes whatever answer it was handed; there is no input to parse here.
const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status });

export const installRunnerMock = (
  apps: RunnerApp[],
  options: RunnerMockOptions = {}
): RunnerMock => {
  controlEnv.RUNNER_TOKEN = "test-token";
  controlEnv.RUNNER_URL = "http://runner.test";
  const original = globalThis.fetch;

  const mock: RunnerMock = {
    apps,
    calls: [],
    requests: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };

  /** The apps collection: list, or create one. */
  const appsCollection = (
    method: string,
    params: Record<string, Json>
  ): Response => {
    if (method === "GET") {
      return json(mock.apps);
    }

    if (method !== "POST") {
      return notFound();
    }

    const slug = String(params.slug ?? "created");

    const timedOut =
      options.onCreate?.(mock, {
        name: String(params.name ?? "Created"),
        slug,
        userId: String(params.userId ?? ""),
      }) === "timeout";

    if (timedOut) {
      throw new DOMException(
        "The operation was aborted due to timeout.",
        "TimeoutError"
      );
    }

    if (mock.apps.some((app) => app.slug === slug)) {
      return new Response("slug already taken", { status: 409 });
    }

    const created = makeApp({
      id: `app-${mock.apps.length + 1}`,
      name: String(params.name ?? "Created"),
      slug,
      userId: String(params.userId ?? ""),
    });

    mock.apps.push(created);

    return json(created, 201);
  };

  /** One app's own route, or a modelled sub-route. */
  const appResource = (
    method: string,
    id: string,
    rest: string
  ): Response | null => {
    const app = mock.apps.find((row) => row.id === id);

    if (rest === "") {
      if (method === "GET") {
        return app ? json(app) : notFound();
      }

      if (method === "DELETE") {
        mock.apps = mock.apps.filter((row) => row.id !== id);

        return new Response(null, { status: 204 });
      }
    }

    if (method === "POST" && rest === "/git-remote") {
      return app ? json({ url: `http://git.test/${app.slug}` }) : notFound();
    }

    return null;
  };

  const answer = (call: MockCall): Response => {
    const { method, path, params } = call;

    if (path === "/v1/apps") {
      return appsCollection(method, params);
    }

    if (method === "GET" && path.startsWith(BY_SLUG_PREFIX)) {
      const slug = decodeURIComponent(path.slice(BY_SLUG_PREFIX.length));
      const app = mock.apps.find((row) => row.slug === slug);

      return app ? json(app) : notFound();
    }

    const appRoute = APP_ROUTE.exec(path);

    if (appRoute) {
      const modelled = appResource(
        method,
        decodeURIComponent(appRoute.groups?.id ?? ""),
        appRoute.groups?.rest ?? ""
      );

      if (modelled) {
        return modelled;
      }
    }

    const resolved = options.resolve?.(call) ?? null;

    if (resolved instanceof MockRefusal) {
      return new Response(resolved.message, {
        status: resolved.status,
      });
    }

    return resolved === null ? notFound() : json(resolved);
  };

  // SAFETY: the mock only needs to satisfy the call shape runnerFetch uses.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();

    // SAFETY: runnerFetch sends a JSON string body for every mutating call and
    // reads the parsed shape back here as a plain object (test-double only).
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the body is a plain JSON string on every runner call; there is no other representation to consider.
    const body: Record<string, Json> | undefined =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- same reason as above.
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, Json>)
        : undefined;

    const query = url.searchParams;
    const params = body ?? Object.fromEntries(query.entries());

    mock.calls.push(`${method} ${url.pathname}`);
    mock.requests.push(params);

    return answer({ method, params, path: url.pathname, query });
  }) as unknown as typeof fetch;

  return mock;
};
