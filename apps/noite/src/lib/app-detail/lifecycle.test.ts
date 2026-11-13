import { describe, expect, test } from "bun:test";

import {
  appLifecycle,
  autoDeployNotice,
  deployIntentLabel,
  deployStatusFacts,
  domainClaim,
  environmentHeaderState,
  isProductionRow,
  isServing,
  issueActions,
  issueState,
  lifecycleView,
} from "./lifecycle";

const view = (
  status: string,
  desiredState: string,
  fleetHold?: { hold: "crash" | "oom"; retryAt: string } | null
) =>
  lifecycleView(
    appLifecycle({ desiredState, fleetHold, status }),
    desiredState
  );

describe("appLifecycle", () => {
  test("a stop beats a failed status: the dot and the button agree", () => {
    const lifecycle = appLifecycle({
      desiredState: "stopped",
      status: "failed",
    });

    expect(lifecycle._tag).toBe("Stopping");
    expect(view("failed", "stopped")).toEqual({
      action: "start",
      label: "Stopping",
      retryable: false,
      tone: "status-warning",
    });
  });

  test("a stopped row with desired stopped is Stopped with a Start", () => {
    expect(view("stopped", "stopped")).toEqual({
      action: "start",
      label: "Stopped",
      retryable: false,
      tone: "status-neutral",
    });
  });

  test("a resumed row that has not converged is Starting", () => {
    expect(view("stopped", "running")).toMatchObject({
      action: "stop",
      label: "Starting",
    });
  });

  test("a provisioned app has no toggle", () => {
    expect(view("provisioned", "running").action).toBeNull();
  });

  test("the runner's undocumented error status is its own state", () => {
    const lifecycle = appLifecycle({
      desiredState: "running",
      imported: true,
      status: "error",
    });

    expect(lifecycle._tag).toBe("ImportFailed");
    expect(view("error", "running")).toMatchObject({
      action: null,
      label: "Error",
      retryable: false,
      tone: "status-error",
    });
    expect(
      lifecycleView(
        appLifecycle({
          desiredState: "running",
          imported: true,
          status: "error",
        }),
        "running"
      ).retryable
    ).toBe(true);
  });

  // The badge table for a fleet the supervisor is retrying: the row still
  // says `running`, and the UI must not paint a green dot over a fleet that
  // crashed or was OOM-killed.
  test("a crash-held fleet reads as crashed, retrying, with its retry time", () => {
    const retryAt = "2026-11-10T16:40:05.000Z";

    expect(
      appLifecycle({
        desiredState: "running",
        fleetHold: { hold: "crash", retryAt },
        status: "running",
      })._tag
    ).toBe("Held");
    expect(view("running", "running", { hold: "crash", retryAt })).toEqual({
      action: "stop",
      label: "Crashed, retrying",
      retryAt,
      retryable: false,
      tone: "status-error",
    });
  });

  test("an OOM-held fleet names the memory kill", () => {
    const retryAt = "2026-11-10T16:40:05.000Z";

    expect(
      lifecycleView(
        appLifecycle({
          desiredState: "running",
          fleetHold: { hold: "oom", retryAt },
          status: "running",
        }),
        "running"
      )
    ).toMatchObject({ label: "Out of memory, retrying", retryAt });
  });

  test("a hold leaves the states that are not a live fleet alone", () => {
    const fleetHold = {
      hold: "crash" as const,
      retryAt: "2026-11-10T16:40:05.000Z",
    };

    // A deliberate stop still reads Stopped (a stopped app is not retried).
    expect(
      appLifecycle({ desiredState: "stopped", fleetHold, status: "stopped" })
        ._tag
    ).toBe("Stopped");
    // A deploy in flight owns the label while its pipeline runs.
    expect(
      appLifecycle({ desiredState: "running", fleetHold, status: "building" })
        ._tag
    ).toBe("Deploying");
    // And no hold at all is the plain running row.
    expect(
      appLifecycle({
        desiredState: "running",
        fleetHold: null,
        status: "running",
      })._tag
    ).toBe("Live");
  });

  test("the runner's schema-default pending row paints as itself", () => {
    expect(view("pending", "running")).toMatchObject({
      action: "stop",
      label: "pending",
      tone: "status-warning",
    });
  });

  test("an unmodelled status is painted as itself, never as Failed", () => {
    expect(view("paused", "running")).toMatchObject({
      label: "paused",
      tone: "status-warning",
    });
  });
});

describe("isServing", () => {
  test("a deploy in flight or a failed one keeps the last release serving", () => {
    expect(isServing({ desiredState: "running", status: "deploying" })).toBe(
      true
    );
    expect(isServing({ desiredState: "running", status: "failed" })).toBe(true);
  });

  test("a deliberate or observed stop serves nothing", () => {
    expect(isServing({ desiredState: "stopped", status: "running" })).toBe(
      false
    );
    expect(isServing({ desiredState: "running", status: "stopped" })).toBe(
      false
    );
  });
});

describe("deployIntentLabel", () => {
  test("a plain push, the sweep or a web commit adds no label", () => {
    expect(deployIntentLabel("deploy", "abc1234def0")).toBeNull();
  });

  test("a rollback names the release it re-runs", () => {
    expect(deployIntentLabel("rollback", "abc1234def05555")).toBe(
      "Rollback to abc1234def05"
    );
    expect(deployIntentLabel("rollback", null)).toBe("Rollback");
  });

  test("an environment deploy reads as the Redeploy action", () => {
    expect(deployIntentLabel("redeploy", "abc1234def0")).toBe("Redeploy");
    expect(
      deployIntentLabel("branch", "abc1234def05555", "refs/heads/feature")
    ).toBe("Deploy feature@abc1234def05");
    expect(deployIntentLabel("branch", null, null)).toBe("Deploy branch");
  });

  test("an unmodelled intent reads as a plain deploy, never another trigger", () => {
    expect(deployIntentLabel("scheduled", "abc1234def0")).toBeNull();
  });
});

describe("deployStatusFacts", () => {
  test("only queued/building/deploying are stoppable", () => {
    expect(deployStatusFacts("queued").inFlight).toBe(true);
    expect(deployStatusFacts("building").inFlight).toBe(true);
    expect(deployStatusFacts("deploying").inFlight).toBe(true);
    expect(deployStatusFacts("success").inFlight).toBe(false);
    expect(deployStatusFacts("failed").inFlight).toBe(false);
    expect(deployStatusFacts("cancelled").inFlight).toBe(false);
    expect(deployStatusFacts("stalled").inFlight).toBe(false);
  });

  test("a stopped or timed-out row is finished and never a success", () => {
    expect(deployStatusFacts("cancelled")).toEqual({
      finished: true,
      inFlight: false,
      label: "Stopped",
      succeeded: false,
    });
    expect(deployStatusFacts("stalled")).toEqual({
      finished: true,
      inFlight: false,
      label: "Timed out",
      succeeded: false,
    });
  });

  test("an unknown status is never treated as success", () => {
    expect(deployStatusFacts("weird").succeeded).toBe(false);
    expect(deployStatusFacts("weird").inFlight).toBe(false);
    // A status the UI does not model still shows the runner's own word.
    expect(deployStatusFacts("weird").label).toBe("weird");
  });
});

describe("environmentHeaderState", () => {
  test("desired stopped surfaces even when the observed status is deploying", () => {
    expect(
      environmentHeaderState({
        desiredState: "stopped",
        lastError: null,
        status: "deploying",
      })
    ).toEqual({
      desiredState: "stopped",
      error: null,
      label: "Stopping",
      stopped: true,
      tone: "status-warning",
    });
  });

  test("a running environment keeps its observed status", () => {
    expect(
      environmentHeaderState({
        desiredState: "running",
        lastError: "boom",
        status: "failed",
      })
    ).toMatchObject({ label: "Failed", stopped: false, tone: "status-error" });
  });
});

describe("issueState", () => {
  test("ignored is never reopened by triage", () => {
    const state = issueState({ regressed: false, status: "ignored" });

    expect(issueActions(state)).toEqual(["open"]);
  });

  test("open offers ignore and resolve", () => {
    expect(
      issueActions(issueState({ regressed: false, status: "open" }))
    ).toEqual(["ignored", "resolved"]);
  });
});

describe("domainClaim", () => {
  test("anything but verified is pending, token kept", () => {
    const claim = domainClaim({ status: "pending", token: "abc" });

    expect(claim._tag).toBe("Pending");
    expect(claim._tag === "Pending" ? claim.token : "").toBe("abc");
  });
});

describe("isProductionRow", () => {
  test("null and the empty fixture alias are both production", () => {
    expect(isProductionRow(null)).toBe(true);
    expect(isProductionRow("")).toBe(true);
    expect(isProductionRow("env_1")).toBe(false);
  });
});

describe("autoDeployNotice", () => {
  test("nothing to say while the runner may still retry", () => {
    expect(autoDeployNotice({ state: "eligible" })).toBeNull();
    expect(
      autoDeployNotice({ failures: 1, sha: "abc123def456", state: "failing" })
    ).toBeNull();
  });

  test("the exhausted line names the sha and the count", () => {
    expect(
      autoDeployNotice({
        failures: 2,
        sha: "abc123def4567890",
        state: "exhausted",
      })
    ).toBe(
      "Automatic deploys paused after 2 failed attempts of abc123def456; push a fix or deploy manually."
    );
  });

  test("a stop is reported as the operator's own", () => {
    expect(
      autoDeployNotice({ sha: "abc123def4567890", state: "stopped" })
    ).toContain("after you stopped abc123def456");
  });
});
