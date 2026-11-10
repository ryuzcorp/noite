import { describe, expect, test } from "bun:test";

import type { RunnerEnvironment } from "../runner";
import {
  CreateMsg,
  CreatePhaseTypes,
  EnvAlertTypes,
  EnvOpTypes,
  GroupMsg,
  VarFormTypes,
  VarListTypes,
  VarsMsg,
  groupBusy,
  updateCreate,
  updateGroup,
  updateVars,
} from "./environment.machine";
import type { CreateModel, GroupModel, VarsModel } from "./environment.machine";

const reload = async (): Promise<void> => {};

const group = (patch: Partial<GroupModel> = {}): GroupModel => ({
  alert: EnvAlertTypes.None(),
  appId: "app_1",
  envId: "env_1",
  expanded: false,
  op: EnvOpTypes.Idle(),
  varsOpen: false,
  ...patch,
});

describe("updateGroup", () => {
  test("a delete pending blocks a public toggle: one row, one mutation", () => {
    const deleting = updateGroup(group(), GroupMsg.DeleteRequested());

    const toggle = updateGroup(
      deleting.model,
      GroupMsg.PublicRequested({ value: true })
    );

    expect(deleting.model.op._tag).toBe("Deleting");
    expect(groupBusy(deleting.model)).toBe(true);
    expect(toggle.cmd).toBeUndefined();
    expect(toggle.model).toBe(deleting.model);
  });

  test("a second delete while one is pending is refused", () => {
    const first = updateGroup(group(), GroupMsg.DeleteRequested());
    const second = updateGroup(first.model, GroupMsg.DeleteRequested());

    expect(first.cmd).toBeDefined();
    expect(second.cmd).toBeUndefined();
  });

  test("a failure names the operation it came from", () => {
    const deploying = updateGroup(group(), GroupMsg.RedeployRequested());

    const failed = updateGroup(
      deploying.model,
      GroupMsg.RedeployFailed({ error: "nope" })
    );

    expect(failed.model.alert).toEqual(
      EnvAlertTypes.Failed({ error: "nope", op: "deploy" })
    );
    expect(failed.model.op._tag).toBe("Idle");
  });
});

const vars = (patch: Partial<VarsModel> = {}): VarsModel => ({
  appId: "app_1",
  envId: "env_1",
  form: VarFormTypes.Closed(),
  list: VarListTypes.Idle(),
  notice: "none",
  ...patch,
});

describe("updateVars", () => {
  test("an empty name is a field error and sends no request", () => {
    const editing = updateVars(vars(), VarsMsg.Opened());

    const submitted = updateVars(
      editing.model,
      VarsMsg.Submitted({ close: () => {}, reload })
    );

    expect(submitted.cmd).toBeUndefined();
    expect(submitted.model.form).toMatchObject({
      error: "Name is required",
      name: "",
    });
  });

  test("a save failure returns to Editing with the input kept", () => {
    const editing = updateVars(vars(), VarsMsg.Opened());

    const named = updateVars(
      editing.model,
      VarsMsg.NameChanged({ value: "DATABASE_URL" })
    );

    const saving = updateVars(
      named.model,
      VarsMsg.Submitted({ close: () => {}, reload })
    );

    const failed = updateVars(
      saving.model,
      VarsMsg.SaveFailed({ error: "nope" })
    );

    expect(failed.model.form).toMatchObject({
      error: "nope",
      name: "DATABASE_URL",
    });
  });

  test("a delete failure keeps the row's name", () => {
    const deleting = updateVars(
      vars(),
      VarsMsg.DeleteRequested({ name: "X", reload })
    );

    const failed = updateVars(
      deleting.model,
      VarsMsg.DeleteFailed({ error: "nope", name: "X" })
    );

    expect(failed.model.list).toEqual(
      VarListTypes.Failed({ error: "nope", name: "X" })
    );
  });
});

const create = (patch: Partial<CreateModel> = {}): CreateModel => ({
  branch: "feature",
  phase: CreatePhaseTypes.Picking(),
  ...patch,
});

const onCreated = (_env: RunnerEnvironment | null): void => {};

describe("updateCreate", () => {
  test("a branch that left the list is refused, never substituted", () => {
    const result = updateCreate(
      create({ branch: "gone" }),
      CreateMsg.Submitted({ appId: "a", available: ["other"], onCreated })
    );

    expect(result.cmd).toBeUndefined();
    expect(result.model.phase).toMatchObject({
      reason: "That branch is no longer available — pick another.",
    });
  });

  test("no pick is refused with its own reason", () => {
    const result = updateCreate(
      create({ branch: null }),
      CreateMsg.Submitted({ appId: "a", available: ["other"], onCreated })
    );

    expect(result.cmd).toBeUndefined();
    expect(result.model.phase).toMatchObject({
      reason: "Pick a branch first.",
    });
  });

  test("a null create answer is a rejection, not a silent close", () => {
    const submitting = updateCreate(
      create(),
      CreateMsg.Submitted({ appId: "a", available: ["feature"], onCreated })
    );

    const rejected = updateCreate(
      submitting.model,
      CreateMsg.Failed({
        error: "Nothing was created — that branch already has an environment.",
      })
    );

    expect(rejected.model.phase._tag).toBe("Rejected");
  });
});
