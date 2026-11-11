/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
//! Test-only stand-in for the Rust runner's JSON-RPC endpoint: installs a
//! `fetch` that answers `/rpc` calls from an in-memory app table and records
//! which methods were called.
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
  calls: string[];
  /** The params of every recorded call, in order (mirrors `calls`). */
  requests: unknown[];
  restore: () => void;
}

export interface RunnerMockOptions {
  /** Runs before the canned `apps.create` answer. Return `"timeout"` to make
   * the call abort the way `AbortSignal.timeout` does when the runner
   * outlives the control plane's bound — the test can push the row it landed
   * onto `mock.apps` first, exactly the detached-create case. */
  onCreate?: (
    mock: RunnerMock,
    params: Record<string, string>
  ) => "timeout" | undefined;
}

interface RpcCall {
  method: string;
  params: Record<string, string>;
}

/** A JSON-RPC error the runner would answer with (e.g. a slug conflict). */
class RpcFailure {
  readonly code: number;
  readonly message: string;

  constructor(code: number, message: string) {
    this.code = code;
    this.message = message;
  }
}

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

  const answer = (call: RpcCall): unknown => {
    switch (call.method) {
      case "apps.list": {
        return mock.apps;
      }

      case "apps.get": {
        return mock.apps.find((app) => app.id === call.params.id) ?? null;
      }

      case "apps.get_by_slug": {
        return mock.apps.find((app) => app.slug === call.params.slug) ?? null;
      }

      case "apps.create": {
        if (options.onCreate?.(mock, call.params) === "timeout") {
          throw new DOMException(
            "The operation was aborted due to timeout.",
            "TimeoutError"
          );
        }

        if (mock.apps.some((app) => app.slug === call.params.slug)) {
          return new RpcFailure(409, "slug already taken");
        }

        const created = makeApp({
          id: `app-${mock.apps.length + 1}`,
          name: String(call.params.name ?? "Created"),
          slug: String(call.params.slug ?? "created"),
          userId: String(call.params.userId ?? ""),
        });

        mock.apps.push(created);

        return created;
      }

      case "apps.delete": {
        mock.apps = mock.apps.filter((app) => app.id !== call.params.id);

        return { deleting: false, ok: true };
      }

      case "git.remote": {
        const app = mock.apps.find((row) => row.id === call.params.id);

        return app ? { url: `http://git.test/${app.slug}` } : null;
      }

      default: {
        return null;
      }
    }
  };

  /** One JSON-RPC call's envelope, from the canned answer. */
  const envelopeFor = (
    body: { id: number } & RpcCall
  ):
    | { error: { code: number; message: string }; id: number }
    | { id: number; jsonrpc: string; result: unknown } => {
    mock.calls.push(body.method);
    mock.requests.push(body.params);
    const result = answer(body);

    if (result instanceof RpcFailure) {
      return {
        error: { code: result.code, message: result.message },
        id: body.id,
      };
    }

    if (result === null) {
      return {
        error: { code: -32_004, message: "app not found" },
        id: body.id,
      };
    }

    return { id: body.id, jsonrpc: "2.0", result };
  };

  // SAFETY: the mock only needs to satisfy the call shape runnerFetch uses.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    // SAFETY: runnerFetch always sends JSON-RPC (one call or a batch) as a
    // string body.
    const body = JSON.parse(String(init?.body)) as
      | ({ id: number } & RpcCall)
      | ({ id: number } & RpcCall)[];

    return Array.isArray(body)
      ? Response.json(body.map((call) => envelopeFor(call)))
      : Response.json(envelopeFor(body));
  }) as unknown as typeof fetch;

  return mock;
};
