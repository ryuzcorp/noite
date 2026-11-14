import { expect, test } from "@playwright/test";

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
    const limitsRes = await runnerCall(
      request,
      `/v1/apps/${encodeURIComponent(appId)}/limits`,
      {
        body: {
          appRpm: null,
          clientRpm: null,
          memoryMb: OOM_CAP_MB,
          // The runner re-checks the app role: this lane created the app, so
          // it calls as its admin.
          role: "admin",
        },
        method: "PUT",
      }
    );

    expect(limitsRes.status, "limits put answers 200").toBe(200);

    // SAFETY: the limits endpoint answers the `LimitsView` JSON object; the
    // assertion below reads the one field this spec set.
    const limits = limitsRes.body as { memoryMb?: number | null };

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

    // The supervisor restarts the fleet like any crash: it serves again. A
    // transport error from the restarting fleet is "not serving yet", and
    // expect.poll only retries a failing matcher — never a throwing
    // generator — so map it to 0 and keep requiring a real 200.
    await expect
      .poll(() => get("/").catch(() => 0), { timeout: 120_000 })
      .toBe(200);

    // The kill recorded the tenant-visible app event naming the cap.
    const eventsQuery = new URLSearchParams({ channel: "fleet", limit: "10" });

    await expect
      .poll(
        async () => {
          const { body, status } = await runnerCall(
            request,
            `/v1/apps/${encodeURIComponent(appId)}/events?${eventsQuery.toString()}`
          );

          expect(status).toBe(200);

          // SAFETY: the events endpoint answers `AppEvent[]`; the assertion
          // below reads `description` only.
          const events = body as AppEvent[];

          return events.some((event) => event.description === expected);
        },
        { timeout: 120_000 }
      )
      .toBe(true);

    // And the fleet log line the tenant reads beside it.
    const logsRes = await runnerCall(
      request,
      `/v1/apps/${encodeURIComponent(appId)}/logs`
    );

    expect(logsRes.status).toBe(200);

    // SAFETY: the logs endpoint answers the line array; the assertion below
    // reads the strings only.
    const lines = logsRes.body as string[];

    expect(
      lines.some((line) => line.includes(expected)),
      "fleet log carries the OOM line"
    ).toBe(true);
  }
);
