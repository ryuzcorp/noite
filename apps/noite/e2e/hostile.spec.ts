import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  appListenPort,
  createAppWithKey,
  deleteApp,
  pushAppDir,
  runnerApi,
  waitForDeploy,
} from "./helpers";

const HOSTILE_SLUG = "hostile";
const NEIGHBOUR_SLUG = "hostile-neighbour";

test.afterAll(async ({ request }) => {
  await deleteApp(request, HOSTILE_SLUG);
  await deleteApp(request, NEIGHBOUR_SLUG);
});

interface Probe {
  ok: boolean;
  detail: string;
  code?: string;
  mustSucceed?: boolean;
}

interface ProbeReport {
  build: { probes: Record<string, Probe> };
  release: { probes: Record<string, Probe> };
  worker: Record<string, Probe>;
  secrets: Record<string, string>;
}

const pushHostileApp = (apiKey: string): string =>
  pushAppDir(apiKey, new URL("../test/hostile", import.meta.url), HOSTILE_SLUG);

// Scoped bucket keys (SPEC, Scoped credentials): the release ran with a key,
// the key reaches its own prefix, and every cross-prefix attempt was refused.
// The presence assertions fail closed: a release that never ran (root mode
// skips it in multi) proves nothing.
const expectReleaseProbes = (probes: Record<string, Probe>): void => {
  for (const name of [
    "s3:scoped-key",
    "s3:own-read-write",
    "s3:cross-app-list",
    "s3:cross-app-write",
    "s3:env-list",
    "s3:root-list",
  ]) {
    expect(
      probes[name],
      `release probe ${name} present (release ran with bucket keys)`
    ).toBeDefined();
  }

  for (const [name, probe] of Object.entries(probes)) {
    if (
      name === "scoped-prefix" ||
      name === "s3:scoped-key" ||
      name === "s3:own-read-write"
    ) {
      expect(probe.ok, `release probe ${name} must hold: ${probe.detail}`).toBe(
        true
      );
      continue;
    }

    expect(probe.ok, `release probe ${name} leaked: ${probe.detail}`).toBe(
      false
    );
  }
};

// Per-fleet cgroups are the inverse probe: containment holds when every live
// fleet carries a positive `memory.max`, read by the sandboxed build itself
// from the shared anchor — and the runner agrees on `/ready`.
const assertFleetCgroups = async (
  request: APIRequestContext,
  report: ProbeReport
): Promise<void> => {
  const cgroup = report.build.probes["cgroup:fleet-memory-max"];
  expect(cgroup, "build probe cgroup:fleet-memory-max present").toBeDefined();
  expect(cgroup?.ok, `per-fleet cgroups missing: ${cgroup?.detail ?? ""}`).toBe(
    true
  );

  const ready = await runnerApi<{ cgroups?: { active?: boolean } }>(
    request,
    "/ready"
  );

  expect(ready.cgroups?.active, "runner reports per-fleet cgroups active").toBe(
    true
  );
};

// Tamper probes are the negative half of the cgroup story: every cgroupfs
// write a tenant build attempts must fail with a permission denial
// (EACCES/EPERM/EROFS). Present and refused, not merely absent — an ENOENT
// from a missing file would pass an any-throw check vacuously, so the probe
// records the errno code and the spec asserts it. swap.max is exempt only
// when swap accounting is genuinely absent (NO_SWAP_ACCOUNTING).
const expectTamperProbes = (report: ProbeReport): void => {
  for (const name of [
    "tamper:write-memory-max",
    "tamper:write-memory-swap-max",
    "tamper:move-to-anchor",
    "tamper:mkdir-fleet-child",
    "tamper:subtree-control",
  ]) {
    const probe = report.build.probes[name];
    expect(probe, `tamper probe ${name} present`).toBeDefined();
    expect(
      probe?.ok,
      `tamper probe ${name} must fail: ${probe?.detail ?? ""}`
    ).toBe(false);

    if (
      name === "tamper:write-memory-swap-max" &&
      probe?.code === "NO_SWAP_ACCOUNTING"
    ) {
      continue;
    }

    const code = probe?.code ?? "";
    expect(
      code === "EACCES" || code === "EPERM" || code === "EROFS",
      `tamper probe ${name} must be refused with EACCES|EPERM|EROFS, got ${code === "" ? "no code" : code}: ${probe?.detail ?? ""}`
    ).toBe(true);
  }
};

// Hostile tenant (SPEC, Hostile-tenant suite): the Worker and build scripts
// attempt each attack and report results as JSON; every attempt must fail
// except internet egress. It only means something against an install that
// claims isolation: the single image with NOITE_TENANCY=multi, its
// capabilities (NET_ADMIN, SETUID, SETGID, CHOWN) and the multi cgroup grant
// (SYS_ADMIN, compose.multi.yaml). The 4-service lane runs single tenancy
// and would fail it by design, so the lane opts in with E2E_HOSTILE=1.
test(
  "hostile tenant is contained",
  { tag: "@isolation" },
  async ({ page, request }, testInfo) => {
    test.skip(
      process.env.E2E_HOSTILE !== "1",
      "needs the isolation lane (E2E_HOSTILE=1, single image, NOITE_TENANCY=multi)"
    );

    // A real neighbour this spec deploys itself (the sample app): its internal
    // (operator) port is the probe target, its public port is how the lane
    // checks it still serves afterwards, and its build cache is what the
    // cross-build probe aims at. Self-deployed so files may run in parallel in
    // any order — borrowing deploy.spec.ts's app serialized the lanes.
    const neighbourApp = await createAppWithKey(page, request, {
      name: "Hostile Neighbour",
      slug: NEIGHBOUR_SLUG,
    });

    pushAppDir(
      neighbourApp.apiKey,
      new URL("../test", import.meta.url),
      NEIGHBOUR_SLUG
    );
    const neighbourDeploy = await waitForDeploy(request, neighbourApp.appId);
    expect(neighbourDeploy.status).toBe("success");

    const { apiKey, appId } = await createAppWithKey(page, request, {
      name: "Hostile",
      slug: HOSTILE_SLUG,
    });

    pushHostileApp(apiKey);
    const deploy = await waitForDeploy(request, appId);
    expect(deploy.status).toBe("success");

    const port = await appListenPort(request, appId);

    // Without a neighbour the probe would aim at a port nothing listens on and
    // pass without proving anything.
    const apps = await runnerApi<
      { internalPort: number | null; listenPort: number | null; slug: string }[]
    >(request, "/v1/apps");

    // Prefer the spec's own neighbour: other files' apps come and go beside
    // this probe under parallel workers, but the neighbour above lives until
    // this file's afterAll.
    const serving = apps.filter(
      (a) => a.internalPort !== null && a.listenPort !== null
    );

    const other =
      serving.find((a) => a.slug === NEIGHBOUR_SLUG) ??
      serving.find((a) => a.slug !== HOSTILE_SLUG);

    expect(other, "needs a second deployed app as the neighbour").toBeDefined();
    const neighbour = other?.internalPort ?? 0;
    const neighbourPublic = other?.listenPort ?? 0;

    const res = await request.get(
      `http://localhost:${port}/probes?neighbour=${neighbour}`
    );

    expect(res.ok()).toBe(true);
    // SAFETY: the hostile worker answers /probes with { build, release, worker, secrets } (test/hostile/index.js).
    const report = (await res.json()) as ProbeReport;

    for (const [name, probe] of Object.entries(report.build.probes)) {
      // Positive containment and the peak snapshot are asserted/attached
      // separately below; this loop is the leak check.
      if (name === "cgroup:fleet-memory-max" || name === "fleet-peaks") {
        continue;
      }

      expect(probe.ok, `build probe ${name} leaked: ${probe.detail}`).toBe(
        false
      );
    }

    // Tamper probes are asserted separately: every cgroupfs write a tenant
    // build attempts must fail with a permission denial — present and
    // refused, not merely absent.
    expectTamperProbes(report);

    // D3 sizing basis: per-fleet high-water marks at build time, attached
    // to the always-uploaded report for the default-cap measurement.
    await testInfo.attach("fleet-peaks", {
      body: Buffer.from(
        JSON.stringify(report.build.probes["fleet-peaks"] ?? { missing: true })
      ),
      contentType: "application/json",
    });

    await assertFleetCgroups(request, report);

    // The cross-build probe only proves isolation if a sibling app's build
    // cache actually existed to probe. The neighbour above deploys first, so
    // its cache is present.
    const crossBuild = report.build.probes["read:sibling-build-cache"];
    expect(
      crossBuild,
      "build probe read:sibling-build-cache present"
    ).toBeDefined();

    const siblings = Number(
      /siblings=(?<count>\d+)/u.exec(crossBuild?.detail ?? "")?.groups?.count ??
        "0"
    );

    expect(
      siblings,
      `needs a sibling app's build cache to probe (${crossBuild?.detail ?? ""})`
    ).toBeGreaterThan(0);

    expectReleaseProbes(report.release.probes);

    for (const [name, probe] of Object.entries(report.worker)) {
      if (probe.mustSucceed === true) {
        expect(probe.ok, `worker egress ${name} must succeed`).toBe(true);
      } else {
        expect(probe.ok, `worker probe ${name} leaked: ${probe.detail}`).toBe(
          false
        );
      }
    }

    for (const [key, value] of Object.entries(report.secrets)) {
      expect(value, `worker env ${key} leaked`).toBe("absent");
    }

    // Neighbour still serves after the probes.
    const neighbourRes = await request.get(
      `http://localhost:${neighbourPublic}/`
    );

    expect([200, 404]).toContain(neighbourRes.status());
  }
);
