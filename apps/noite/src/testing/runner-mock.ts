/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
//! Test-only stand-in for the Rust runner's JSON-RPC endpoint: installs a
//! `fetch` that answers `/rpc` calls from an in-memory app table and records
//! which methods were called.
import { controlEnv } from "../lib/control-env";
import type { RunnerApp } from "../lib/runner";

export const makeApp = (over: Partial<RunnerApp> = {}): RunnerApp => ({
  createdAt: "2026-01-01T00:00:00Z",
  desiredState: "running",
  fleetBucket: "",
  gitPrefix: "",
  id: "app-1",
  internalPort: null,
  lastDeploySha: null,
  lastError: null,
  listenPort: null,
  name: "App One",
  slug: "app-one",
  status: "running",
  subdomain: "app-one.localhost",
  updatedAt: "2026-01-01T00:00:00Z",
  userId: "u-creator",
  ...over,
});

export interface RunnerMock {
  apps: RunnerApp[];
  calls: string[];
  restore: () => void;
}

interface RpcCall {
  method: string;
  params: Record<string, string>;
}

export const installRunnerMock = (apps: RunnerApp[]): RunnerMock => {
  controlEnv.RUNNER_TOKEN = "test-token";
  controlEnv.RUNNER_URL = "http://runner.test";
  const original = globalThis.fetch;
  const mock: RunnerMock = {
    apps,
    calls: [],
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
      default: {
        return null;
      }
    }
  };
  // SAFETY: the mock only needs to satisfy the call shape runnerFetch uses.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    // SAFETY: runnerFetch always sends a JSON-RPC envelope as a string body.
    const body = JSON.parse(String(init?.body)) as { id: number } & RpcCall;
    mock.calls.push(body.method);
    const result = answer(body);
    const envelope =
      result === null
        ? { error: { code: -32_004, message: "app not found" }, id: body.id }
        : { id: body.id, jsonrpc: "2.0", result };
    return Response.json(envelope);
  }) as unknown as typeof fetch;
  return mock;
};
