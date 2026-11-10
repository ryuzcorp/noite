import { describe, expect, test } from "bun:test";

import {
  DropdownActionTypes,
  DropdownMsg,
  LookupTypes,
  RowActionTypes,
  RowMsg,
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
      lookup: LookupTypes.Found({ sha: "bbb" }),
    });

    const result = updateDropdown(
      found,
      DropdownMsg.RollbackRequested({ sha: "ccc" })
    );

    expect(result.cmd).toBeUndefined();
    expect(result.model.action._tag).toBe("Idle");
  });

  test("a second rollback click is refused while one is in flight", () => {
    const found = dropdown({ lookup: LookupTypes.Found({ sha: "bbb" }) });

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

  test("a successful action reloads the targets so the new live sha is excluded", () => {
    const rolling = dropdown({
      action: DropdownActionTypes.RollingBack(),
      lookup: LookupTypes.Found({ sha: "bbb" }),
    });

    const done = updateDropdown(rolling, DropdownMsg.Succeeded());

    expect(done.model.lookup._tag).toBe("Loading");
    expect(done.cmd).toBeDefined();
  });

  test("an old lookup answer cannot overwrite a closed one", () => {
    const none = dropdown({ lookup: LookupTypes.None() });

    expect(
      updateDropdown(none, DropdownMsg.TargetsLoaded({ sha: "bbb" })).model
    ).toBe(none);
  });
});
