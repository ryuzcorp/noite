import { describe, expect, test } from "bun:test";

import type { AppDetail } from "../api-types";
import { keys } from "../resources";
import type { RunnerApp, RunnerAppState, RunnerEnvironment } from "../runner";
import { staleKeys } from "./state-sync";

const app = (patch: Partial<RunnerApp> = {}): RunnerApp => ({
  asleepSince: null,
  createdAt: "2026-10-20T00:00:00Z",
  desiredState: "running",
  fleetBucket: "noite",
  gitPrefix: "git/demo",
  id: "app_1",
  imported: false,
  internalPort: 30_001,
  lastDeploySha: "aaa111",
  lastError: null,
  listenPort: 30_000,
  name: "Demo",
  slug: "demo",
  status: "deploying",
  subdomain: "demo.noite.localhost",
  updatedAt: "2026-10-20T00:00:00Z",
  userId: "u_1",
  wokeAt: null,
  ...patch,
});

const env = (patch: Partial<RunnerEnvironment> = {}): RunnerEnvironment => ({
  appId: "app_1",
  appSlug: "demo",
  asleepSince: null,
  createdAt: "2026-10-20T00:00:00Z",
  createdBy: "u_1",
  desiredState: "running",
  fleetBucket: "noite",
  gitRef: "refs/heads/feature",
  id: "env_1",
  internalPort: 31_001,
  kind: "branch",
  label: "feature",
  lastDeploySha: "bbb222",
  lastDeployedAt: null,
  lastError: null,
  listenPort: 31_000,
  public: false,
  status: "deploying",
  updatedAt: "2026-10-20T00:00:00Z",
  wokeAt: null,
  ...patch,
});

const detail = (patch: Partial<RunnerApp> = {}): AppDetail => ({
  app: app(patch),
  gitHint: "",
  gitRemote: "",
  host: "demo.noite.localhost",
  myRole: "admin",
  s3Endpoint: "",
  username: "u_1",
});

const frame = (
  appPatch: Partial<RunnerApp> = {},
  environments: RunnerEnvironment[] = [env()]
): RunnerAppState => ({ app: app(appPatch), environments });

describe("staleKeys", () => {
  test("a finished deploy makes the cached detail stale, the sidebar's peers follow", () => {
    expect(
      staleKeys(
        "app_1",
        frame({ lastDeploySha: "ccc333", status: "running" }),
        detail(),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
  });

  test("an environment that changed status makes the environments stale", () => {
    expect(
      staleKeys("app_1", frame({}, [env({ status: "running" })]), detail(), [
        env(),
      ])
    ).toEqual([keys.environments("app_1")]);
  });

  test("an environment created or deleted elsewhere makes the list stale", () => {
    const added = frame({}, [env(), env({ id: "env_2", label: "other" })]);

    expect(staleKeys("app_1", added, detail(), [env()])).toEqual([
      keys.environments("app_1"),
    ]);
    expect(staleKeys("app_1", frame({}, []), detail(), [env()])).toEqual([
      keys.environments("app_1"),
    ]);
  });

  test("a stop or a sleep shows too, not only a deploy", () => {
    expect(
      staleKeys("app_1", frame({ desiredState: "stopped" }), detail(), [env()])
    ).toEqual([keys.appDetail("app_1")]);
    expect(
      staleKeys(
        "app_1",
        frame({ asleepSince: "2026-10-20T01:00:00Z", status: "sleeping" }),
        detail(),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
  });

  test("a fleet hold appearing, changing or lifting refetches the detail", () => {
    const hold = {
      hold: "crash" as const,
      retryAt: "2026-11-10T16:40:05.000Z",
    };

    // The badge flips to "crashed, retrying" and back: both are shown.
    expect(
      staleKeys("app_1", frame({ fleetHold: hold }), detail(), [env()])
    ).toEqual([keys.appDetail("app_1")]);
    expect(
      staleKeys("app_1", frame(), detail({ fleetHold: hold }), [env()])
    ).toEqual([keys.appDetail("app_1")]);
    // A later attempt (a new deadline, same reason) moves the time.
    expect(
      staleKeys(
        "app_1",
        frame({ fleetHold: { ...hold, retryAt: "2026-11-10T16:41:05.000Z" } }),
        detail({ fleetHold: hold }),
        [env()]
      )
    ).toEqual([keys.appDetail("app_1")]);
    // The same hold at sub-second jitter is not a change.
    expect(
      staleKeys(
        "app_1",
        frame({ fleetHold: { ...hold, retryAt: "2026-11-10T16:40:05.499Z" } }),
        detail({ fleetHold: hold }),
        [env()]
      )
    ).toEqual([]);
  });

  test("bookkeeping a page never shows refetches nothing", () => {
    expect(
      staleKeys(
        "app_1",
        frame({ updatedAt: "2026-10-20T02:00:00Z", wokeAt: "x" }, [
          env({ updatedAt: "2026-10-20T02:00:00Z" }),
        ]),
        detail(),
        [env()]
      )
    ).toEqual([]);
  });

  test("a cache never fetched is left to its own first fetch", () => {
    expect(staleKeys("app_1", frame({ status: "running" }))).toEqual([]);
  });

  test("a role change in the frame invalidates the detail (demoted users lose admin buttons)", () => {
    const demoted = { ...frame(), myRole: "view" as const };

    expect(staleKeys("app_1", demoted, detail(), [env()])).toEqual([
      keys.appDetail("app_1"),
    ]);
  });

  test("a frame without a role never counts as a role change", () => {
    expect(staleKeys("app_1", frame(), detail(), [env()])).toEqual([]);
  });
});
