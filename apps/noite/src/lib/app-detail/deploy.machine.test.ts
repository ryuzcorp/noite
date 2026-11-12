import { describe, expect, test } from "bun:test";

import {
  DropdownActionTypes,
  DropdownMsg,
  LookupTypes,
  RowActionTypes,
  RowMsg,
  rollbackTarget,
  updateDropdown,
  updateRow,
} from "./deploy.machine";
import type { DropdownModel, RowModel } from "./deploy.machine";

const row = (action: RowModel["action"] = RowActionTypes.Idle()): RowModel => ({
  action,
  expanded: null,
  tab: "deploy",
});

describe("updateRow", () => {
  test("a 409 from Stop is AlreadyClosed, not a permanent red error", () => {
    const stopping = updateRow(
      row(),
      RowMsg.StopRequested({ appId: "a", deployId: "d" })
    );

    const result = updateRow(stopping.model, RowMsg.StopConflict());

    expect(result.model.action._tag).toBe("AlreadyClosed");
  });

  test("Stop while Stopping is refused: no second destructive call", () => {
    const first = updateRow(
      row(),
      RowMsg.StopRequested({ appId: "a", deployId: "d" })
    );

    const second = updateRow(
      first.model,
      RowMsg.StopRequested({ appId: "a", deployId: "d" })
    );

    expect(first.cmd).toBeDefined();
    expect(second.cmd).toBeUndefined();
    expect(second.model).toBe(first.model);
  });

  test("a rollback request while stopping is refused", () => {
    const stopping = updateRow(
      row(),
      RowMsg.StopRequested({ appId: "a", deployId: "d" })
    );

    const result = updateRow(
      stopping.model,
      RowMsg.RollbackRequested({
        appId: "a",
        deployId: "d",
        environmentId: "",
        sha: "abc",
      })
    );

    expect(result.cmd).toBeUndefined();
    expect(result.model).toBe(stopping.model);
  });

  test("a failed stop keeps its kind so only that action's error paints", () => {
    const stopping = updateRow(
      row(),
      RowMsg.StopRequested({ appId: "a", deployId: "d" })
    );

    const result = updateRow(
      stopping.model,
      RowMsg.StopFailed({ error: "nope" })
    );

    expect(result.model.action).toMatchObject({ kind: "stop" });
  });

  test("logs toggle from the live default, then inverts the reader's choice", () => {
    const opened = updateRow(row(), RowMsg.LogsToggled({ live: true }));

    expect(opened.model.expanded).toBe(false);
  });
});

const dropdown = (patch: Partial<DropdownModel> = {}): DropdownModel => ({
  action: DropdownActionTypes.Idle(),
  appId: "app_1",
  branch: null,
  liveSha: "aaa",
  lookup: LookupTypes.Idle(),
  ...patch,
});

describe("updateDropdown", () => {
  test("a failed lookup is Failed, never None", () => {
    const loading = updateDropdown(
      dropdown(),
      DropdownMsg.TargetsOpened({ liveSha: "aaa" })
    );

    const failed = updateDropdown(
      loading.model,
      DropdownMsg.TargetsFailed({ error: "boom" })
    );

    expect(failed.model.lookup._tag).toBe("Failed");
  });

  test("a stale target cannot be rolled back", () => {
    const found = dropdown({
      lookup: LookupTypes.Found({ candidates: ["bbb"] }),
    });

    const result = updateDropdown(
      found,
      DropdownMsg.RollbackRequested({ sha: "ccc" })
    );

    expect(result.cmd).toBeUndefined();
    expect(result.model.action._tag).toBe("Idle");
  });

  test("a second rollback click is refused while one is in flight", () => {
    const found = dropdown({
      lookup: LookupTypes.Found({ candidates: ["bbb"] }),
    });

    const first = updateDropdown(
      found,
      DropdownMsg.RollbackRequested({ sha: "bbb" })
    );

    const second = updateDropdown(
      first.model,
      DropdownMsg.RollbackRequested({ sha: "bbb" })
    );

    expect(first.cmd).toBeDefined();
    expect(second.cmd).toBeUndefined();
    expect(second.model).toBe(first.model);
  });

  test("picking a branch keeps it, and Deploy runs that branch once", () => {
    const picked = updateDropdown(
      dropdown(),
      DropdownMsg.BranchPicked({ branch: "feature" })
    );

    expect(picked.model.branch).toBe("feature");

    const deploying = updateDropdown(
      picked.model,
      DropdownMsg.BranchDeployRequested({ branch: "feature" })
    );

    expect(deploying.cmd).toBeDefined();
    expect(deploying.model.action._tag).toBe("Deploying");
  });

  test("a branch deploy while another action is in flight is refused", () => {
    const deploying = dropdown({
      action: DropdownActionTypes.Deploying(),
      branch: "feature",
    });

    const second = updateDropdown(
      deploying,
      DropdownMsg.BranchDeployRequested({ branch: "feature" })
    );

    expect(second.cmd).toBeUndefined();
    expect(second.model).toBe(deploying);
  });

  test("an empty branch never starts a deploy", () => {
    const result = updateDropdown(
      dropdown(),
      DropdownMsg.BranchDeployRequested({ branch: "" })
    );

    expect(result.cmd).toBeUndefined();
    expect(result.model.action._tag).toBe("Idle");
  });

  test("a failed branch deploy can be retried without a reload", () => {
    const failed = updateDropdown(
      dropdown({
        action: DropdownActionTypes.Failed({
          error: "nope",
          kind: "branch",
        }),
        branch: "feature",
      }),
      DropdownMsg.BranchDeployRequested({ branch: "feature" })
    );

    expect(failed.cmd).toBeDefined();
    expect(failed.model.action._tag).toBe("Deploying");
  });

  test("a failed branch deploy keeps its kind so only that error paints", () => {
    const result = updateDropdown(
      dropdown({ action: DropdownActionTypes.Deploying() }),
      DropdownMsg.BranchDeployFailed({ error: "nope" })
    );

    expect(result.model.action).toMatchObject({
      error: "nope",
      kind: "branch",
    });
  });

  test("a successful action reloads the targets so the new live sha is excluded", () => {
    const rolling = dropdown({
      action: DropdownActionTypes.RollingBack(),
      lookup: LookupTypes.Found({ candidates: ["bbb"] }),
    });

    const done = updateDropdown(rolling, DropdownMsg.Succeeded());

    expect(done.model.lookup._tag).toBe("Loading");
    expect(done.cmd).toBeDefined();
  });

  test("an old lookup answer cannot overwrite a closed one", () => {
    const none = dropdown({ lookup: LookupTypes.None() });

    expect(
      updateDropdown(none, DropdownMsg.TargetsLoaded({ candidates: ["bbb"] }))
        .model
    ).toBe(none);
  });
});

describe("rollbackTarget", () => {
  // The surviving flake (run 42838911565, multi shard 2): the menu opened
  // while the header still painted the previous snapshot, so the lookup ran
  // with `lastDeploySha` null and the DOM offered "Roll back to
  // 6eb24527f829" — the release already serving — instead of the previous
  // one, for the whole 30 s assertion. The rows are facts; the target is
  // derived against the live sha at render, so the detail landing fixes the
  // label instead of freezing it.
  test("tracks the live sha that lands after the open", () => {
    const rows = ["6eb24527f829", "19178faa1d4a", "6eb24527f829"];

    expect(rollbackTarget(rows, "6eb24527f829")).toBe("19178faa1d4a");
    expect(rollbackTarget(rows, "19178faa1d4a")).toBe("6eb24527f829");
    // Before the detail lands no release is known to serve, so the newest
    // row is the only target the history can offer.
    expect(rollbackTarget(rows, null)).toBe("6eb24527f829");
    expect(rollbackTarget([], "6eb24527f829")).toBe("");
    expect(rollbackTarget(["", "abc"], null)).toBe("abc");
  });
});
