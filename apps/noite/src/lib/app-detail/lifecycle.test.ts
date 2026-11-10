import { describe, expect, test } from "bun:test";

import {
  appLifecycle,
  deployStatusFacts,
  domainClaim,
  environmentHeaderState,
  isProductionRow,
  issueActions,
  issueState,
  lifecycleView,
} from "./lifecycle";

const view = (status: string, desiredState: string) =>
  lifecycleView(appLifecycle({ desiredState, status }), desiredState);

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

  test("an unmodelled status is painted as itself, never as Failed", () => {
    expect(view("paused", "running")).toMatchObject({
      label: "paused",
      tone: "status-warning",
    });
  });
});

describe("deployStatusFacts", () => {
  test("only queued/building/deploying are stoppable", () => {
    expect(deployStatusFacts("queued").inFlight).toBe(true);
    expect(deployStatusFacts("building").inFlight).toBe(true);
    expect(deployStatusFacts("deploying").inFlight).toBe(true);
    expect(deployStatusFacts("success").inFlight).toBe(false);
    expect(deployStatusFacts("failed").inFlight).toBe(false);
  });

  test("an unknown status is never treated as success", () => {
    expect(deployStatusFacts("weird").succeeded).toBe(false);
    expect(deployStatusFacts("weird").inFlight).toBe(false);
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
