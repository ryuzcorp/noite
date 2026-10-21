import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerCall,
  waitForDeploy,
} from "./helpers";

const OOM_SLUG = "oom-fleet";

// Small per-app cap in MiB, set from the measured idle peak (D3): just above
// it, so the fleet deploys healthy. Each burst holds eight 64 MiB
// allocations in flight at once (512 MiB fleet-wide, 64 per isolate), so the
// kernel's per-fleet `memory.max` trips while every isolate stays well under
// its own 128 MiB heap cap — an isolate OOM aborts the process without a
// cgroup `oom_kill`, which would restart the fleet but record no event.
const OOM_CAP_MB = 256;
const GROW_MB = 64;
const BURST = 8;

test.afterAll(async ({ request }) => {
  await deleteApp(request, OOM_SLUG);
});

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { message: string };
}

interface RpcParams {
  id: string;
  appRpm?: number | null;
  clientRpm?: number | null;
  memoryMb?: number | null;
  channel?: string;
  limit?: number;
  environmentId?: string;
}

const rpc = async <T>(
  request: APIRequestContext,
  method: string,
  params: RpcParams
): Promise<T> => {
  const { body, status } = await runnerCall(request, "/rpc", {
    body: { id: 1, jsonrpc: "2.0", method, params },
    method: "POST",
  });

  expect(status, `rpc ${method} answers 200`).toBe(200);
  const clone: unknown = structuredClone(body);
  // SAFETY: the runner answers `{ body }`-less JSON matching the method's
  // result shape (runnerFetch contract). This narrows the boundary clone;
  // each caller asserts on the shape it reads.
  const response = clone as RpcResponse;

  expect(response.error, `rpc ${method} has no error`).toBeUndefined();

  const result: unknown = structuredClone(response.result);

  // SAFETY: same boundary clone, narrowed to the caller's expected shape
  // and asserted on immediately by the caller.
  return result as T;
};

interface AppEvent {
  event: string;
  description: string;
  channel: string;
}

// Per-fleet OOM kills are tenant-visible (SPEC, Tenant isolation): a Worker
// that allocates past its cap is killed inside its own group, the supervisor
// restarts the fleet like any crash, and the kill records a `fleet` app
// event plus a fleet log line naming the cap. It only means something where
// cgroups are live: the single image with NOITE_TENANCY=multi and the multi
// cgroup grant. The lane opts in with E2E_HOSTILE=1, like hostile.spec.ts.
test(
  "a fleet that outgrows its cap restarts with a tenant-visible event",
  { tag: "@isolation" },
  async ({ page, request }) => {
    test.skip(
      process.env.E2E_HOSTILE !== "1",
      "needs the isolation lane (E2E_HOSTILE=1, single image, NOITE_TENANCY=multi)"
    );

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "OOM Fleet",
      slug: OOM_SLUG,
    });

    // The cap applies on the fleet's next spawn, so set it before the first
    // deploy: the fleet is born capped.
    const limits = await rpc<{ memoryMb?: number | null }>(
      request,
      "limits.set",
      {
        appRpm: null,
        clientRpm: null,
        id: appId,
        memoryMb: OOM_CAP_MB,
      }
    );

    expect(limits.memoryMb, "per-app memory override stored").toBe(OOM_CAP_MB);

    pushAppDir(apiKey, new URL("../test/oom-fleet", import.meta.url), OOM_SLUG);
    const deploy = await waitForDeploy(request, appId);
    expect(deploy.status).toBe("success");

    const port = await appListenPort(request, appId);

    const get = async (path: string): Promise<number> => {
      const res = await request.get(`http://localhost:${port}${path}`);

      return res.status();
    };

    // Grow the fleet past its cap in concurrent bursts: eight 64 MiB
    // allocations in flight at once (512 MiB fleet-wide, 64 per isolate)
    // overlap in the fleet whichever isolate serves them, and sequential
    // bursts accumulate when isolates persist. Either way the fleet total
    // crosses the 256 MiB cap while every isolate stays well under its own
    // 128 MiB heap limit. The request in flight when the kernel's OOM-killer
    // fires never answers (its connection dies with the fleet); later
    // requests fail while the supervisor respawns it.
    let killObserved = false;

    for (let batch = 1; batch <= 4; batch += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential bursts with an early break: each burst builds on the last allocation
      const settled = await Promise.allSettled(
        Array.from({ length: BURST }, () => get(`/grow?mb=${GROW_MB}`))
      );

      const alive = settled.filter(
        (result) => result.status === "fulfilled" && result.value === 200
      ).length;

      if (alive < BURST) {
        killObserved = true;
        break;
      }
    }

    // The kill itself, before the event: at least one burst request died
    // with the fleet. If the fleet survived every burst, no OOM kill
    // happened and no event is coming — fail here, not after a 120 s wait
    // for the impossible.
    expect(
      killObserved,
      "fleet survived every growth burst (no OOM kill to observe)"
    ).toBe(true);

    const expected = `fleet restarted: memory limit ${OOM_CAP_MB} MiB exceeded (Settings → Limits)`;

    // The supervisor restarts the fleet like any crash: it serves again.
    await expect.poll(() => get("/"), { timeout: 120_000 }).toBe(200);

    // The kill recorded the tenant-visible app event naming the cap.
    await expect
      .poll(
        async () => {
          const events = await rpc<AppEvent[]>(request, "events.list", {
            channel: "fleet",
            id: appId,
            limit: 10,
          });

          return events.some((event) => event.description === expected);
        },
        { timeout: 120_000 }
      )
      .toBe(true);

    // And the fleet log line the tenant reads beside it.
    const lines = await rpc<string[]>(request, "logs.get", { id: appId });

    expect(
      lines.some((line) => line.includes(expected)),
      "fleet log carries the OOM line"
    );
  }
);
