//! The Deployments tab's three interacting islands as explicit machines,
//! shared by their components:
//!
//! * `EnvironmentGroup` — one environment's header actions;
//! * `EnvironmentVars` — the variable-override editor;
//! * `CreateEnvironmentDialog` — the branch picker.
//!
//! Environment group:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Public: PublicRequested
//!   Idle --> Deploying: RedeployRequested
//!   Idle --> Deleting: DeleteRequested
//!   Public --> Idle: PublicSaved
//!   Deploying --> Idle: RedeployQueued
//!   Deleting --> Idle: Deleted
//!   Public --> Failed: PublicFailed
//!   Deploying --> Failed: RedeployFailed
//!   Deleting --> Failed: DeleteFailed
//!   Failed --> Idle: Dismissed
//! ```
//!
//! Mutations on one environment row are serialized: the pending tag names the
//! action (so only that control shows progress and only that action's error
//! paints); a request while another is in flight is refused. The header also
//! paints the runner's `desired_state` — an environment stopped by the runner
//! is not "deploying" even when the observed status lags.
//!
//! Variable editor:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Closed
//!   Closed --> Editing: Opened
//!   Editing --> Editing: NameChanged | ValueChanged | Rejected
//!   Editing --> Saving: Submitted (name non-empty)
//!   Saving --> Closed: Saved
//!   Saving --> Editing: SaveFailed
//!   Editing --> Closed: Cancelled
//!   Closed --> Deleting: DeleteRequested
//!   Deleting --> Closed: Deleted
//!   Deleting --> DeleteFailed: DeleteFailed
//! ```
//!
//! Create environment (branch picker):
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Picking
//!   Picking --> Picking: BranchPicked
//!   Picking --> Rejected: Submitted (no/unknown branch)
//!   Picking --> Submitting: Submitted (branch available)
//!   Submitting --> Rejected: Created(null)
//!   Submitting --> Picking: Created(env) — dialog closed by the command
//!   Submitting --> Rejected: Failed
//!   Rejected --> Picking: BranchPicked
//! ```
//!
//! The picker never coerces: a branch that leaves the list resets the
//! selection (the island is keyed by the available set), and a submit with a
//! branch the list no longer holds is refused instead of creating the first
//! one.

/* oxlint-disable promise/prefer-await-to-callbacks -- a command factory takes message constructors, not continuation callbacks: the Effect runs them and every answer becomes a message */
import { keyed } from "@ilha/model";
import type { Cmd } from "@ilha/model";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { api } from "../api";
import { errorMessage } from "../errors";
import { invalidate } from "../resource";
import { keys } from "../resources";
import type { RunnerEnvironment } from "../runner";
import type { DesiredState } from "./lifecycle";
import type { Step } from "./step";

const attempt = <Message>(
  work: () => Promise<void>,
  ok: () => Message,
  fail: (error: Error) => Message
): Cmd<Message> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: work,
  }).pipe(
    Effect.match({
      onFailure: (error) => fail(error),
      onSuccess: () => ok(),
    })
  );

// --- environment group ----------------------------------------------------

export type Mutation = "delete" | "deploy" | "public";

export type EnvOp = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Public: { readonly value: boolean };
  Deploying: Record<never, never>;
  Deleting: Record<never, never>;
}>;

export const EnvOpTypes = Data.taggedEnum<EnvOp>();

export type EnvAlert = Data.TaggedEnum<{
  None: Record<never, never>;
  Failed: { readonly error: string; readonly op: Mutation };
}>;

export const EnvAlertTypes = Data.taggedEnum<EnvAlert>();

export interface GroupModel {
  readonly appId: string;
  readonly expanded: boolean;
  readonly envId: string;
  readonly op: EnvOp;
  readonly alert: EnvAlert;
  readonly varsOpen: boolean;
}

export type GroupMessage = Data.TaggedEnum<{
  DeleteFailed: { readonly error: string };
  DeleteRequested: Record<never, never>;
  Deleted: Record<never, never>;
  Dismissed: Record<never, never>;
  ExpandedToggled: Record<never, never>;
  PublicFailed: { readonly error: string };
  PublicRequested: { readonly value: boolean };
  PublicSaved: Record<never, never>;
  RedeployFailed: { readonly error: string };
  RedeployQueued: Record<never, never>;
  RedeployRequested: Record<never, never>;
  VarsToggled: Record<never, never>;
}>;

export const GroupMsg = Data.taggedEnum<GroupMessage>();

/** The runner call behind one pending operation. */
const envCall = (
  model: GroupModel,
  message: GroupMessage
): Cmd<GroupMessage> => {
  switch (message._tag) {
    case "PublicRequested": {
      return keyed(
        `env-public:${model.envId}`,
        attempt<GroupMessage>(
          async () => {
            await api<{ ok: true }>("/api/environments/updateEnvironment", {
              appId: model.appId,
              envId: model.envId,
              public: message.value,
            });

            invalidate(keys.environments(model.appId));
          },
          () => GroupMsg.PublicSaved(),
          (error) => GroupMsg.PublicFailed({ error: error.message })
        )
      );
    }

    case "RedeployRequested": {
      return keyed(
        `env-deploy:${model.envId}`,
        attempt<GroupMessage>(
          async () => {
            await api<{ ok: true }>("/api/environments/deployEnvironment", {
              appId: model.appId,
              envId: model.envId,
            });

            invalidate(keys.environments(model.appId));
          },
          () => GroupMsg.RedeployQueued(),
          (error) => GroupMsg.RedeployFailed({ error: error.message })
        )
      );
    }

    case "DeleteRequested": {
      return keyed(
        `env-delete:${model.envId}`,
        attempt<GroupMessage>(
          async () => {
            await api<{ ok: true }>("/api/environments/deleteEnvironment", {
              appId: model.appId,
              envId: model.envId,
            });

            invalidate(keys.environments(model.appId));
          },
          () => GroupMsg.Deleted(),
          (error) => GroupMsg.DeleteFailed({ error: error.message })
        )
      );
    }

    default: {
      return Effect.void;
    }
  }
};

const busy = (model: GroupModel): boolean => model.op._tag !== "Idle";

/** The one transition function for an environment group. */
export const updateGroup = (
  model: GroupModel,
  message: GroupMessage
): Step<GroupModel, GroupMessage> => {
  switch (message._tag) {
    case "ExpandedToggled": {
      return { model: { ...model, expanded: !model.expanded } };
    }

    case "VarsToggled": {
      return { model: { ...model, varsOpen: !model.varsOpen } };
    }

    case "Dismissed": {
      return { model: { ...model, alert: EnvAlertTypes.None() } };
    }

    case "PublicRequested": {
      if (busy(model) || model.op._tag === "Public") {
        return { model };
      }

      return {
        cmd: envCall(model, message),
        model: {
          ...model,
          alert: EnvAlertTypes.None(),
          op: EnvOpTypes.Public({ value: message.value }),
        },
      };
    }

    case "RedeployRequested": {
      if (busy(model)) {
        return { model };
      }

      return {
        cmd: envCall(model, message),
        model: {
          ...model,
          alert: EnvAlertTypes.None(),
          op: EnvOpTypes.Deploying(),
        },
      };
    }

    case "DeleteRequested": {
      if (busy(model)) {
        return { model };
      }

      return {
        cmd: envCall(model, message),
        model: {
          ...model,
          alert: EnvAlertTypes.None(),
          op: EnvOpTypes.Deleting(),
        },
      };
    }

    case "PublicSaved":
    case "RedeployQueued":
    case "Deleted": {
      return { model: { ...model, op: EnvOpTypes.Idle() } };
    }

    case "PublicFailed": {
      return {
        model: {
          ...model,
          alert: EnvAlertTypes.Failed({ error: message.error, op: "public" }),
          op: EnvOpTypes.Idle(),
        },
      };
    }

    case "RedeployFailed": {
      return {
        model: {
          ...model,
          alert: EnvAlertTypes.Failed({ error: message.error, op: "deploy" }),
          op: EnvOpTypes.Idle(),
        },
      };
    }

    case "DeleteFailed": {
      return {
        model: {
          ...model,
          alert: EnvAlertTypes.Failed({ error: message.error, op: "delete" }),
          op: EnvOpTypes.Idle(),
        },
      };
    }

    default: {
      return { model };
    }
  }
};

/** Whether one of the group's controls starts a mutation. Used to disable the
 * control the pending operation owns, and to refuse a request in `update`. */
export const groupBusy = (model: GroupModel): boolean => busy(model);

/** `desired_state` stopped and not yet reflected in `status`: the header
 * says "Stopping" and no deploy can be requested meanwhile. */
export const groupStopping = (desired: DesiredState, status: string): boolean =>
  desired === "stopped" && status !== "stopped";

// --- environment variables ------------------------------------------------

export type VarForm = Data.TaggedEnum<{
  Closed: Record<never, never>;
  Editing: {
    readonly error: string | null;
    readonly name: string;
    readonly value: string;
  };
  Saving: { readonly name: string; readonly value: string };
}>;

export const VarFormTypes = Data.taggedEnum<VarForm>();

export type VarList = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Deleting: { readonly name: string };
  Failed: { readonly error: string; readonly name: string };
}>;

export const VarListTypes = Data.taggedEnum<VarList>();

export interface VarsModel {
  readonly appId: string;
  readonly envId: string;
  readonly form: VarForm;
  readonly list: VarList;
  readonly notice: "none" | "saved";
}

export type VarsMessage = Data.TaggedEnum<{
  Cancelled: Record<never, never>;
  DeleteFailed: { readonly error: string; readonly name: string };
  DeleteRequested: {
    readonly name: string;
    readonly reload: () => Promise<void>;
  };
  Deleted: Record<never, never>;
  NameChanged: { readonly value: string };
  Opened: Record<never, never>;
  Saved: Record<never, never>;
  SaveFailed: { readonly error: string };
  Submitted: {
    readonly close: () => void;
    readonly reload: () => Promise<void>;
  };
  ValueChanged: { readonly value: string };
}>;

export const VarsMsg = Data.taggedEnum<VarsMessage>();

const writeVar = (
  model: VarsModel,
  name: string,
  value: string,
  close: () => void,
  reload: () => Promise<void>
): Cmd<VarsMessage> =>
  attempt<VarsMessage>(
    async () => {
      await api<{ ok: true }>("/api/environments/setEnvironmentVar", {
        appId: model.appId,
        envId: model.envId,
        name,
        value,
      });

      close();
      await reload();
    },
    () => VarsMsg.Saved(),
    (error) => VarsMsg.SaveFailed({ error: error.message })
  );

const deleteVar = (
  model: VarsModel,
  name: string,
  reload: () => Promise<void>
): Cmd<VarsMessage> =>
  attempt<VarsMessage>(
    async () => {
      await api<{ ok: true }>("/api/environments/deleteEnvironmentVar", {
        appId: model.appId,
        envId: model.envId,
        name,
      });

      await reload();
    },
    () => VarsMsg.Deleted(),
    (error) => VarsMsg.DeleteFailed({ error: error.message, name })
  );

/** The one transition function for the override editor. */
export const updateVars = (
  model: VarsModel,
  message: VarsMessage
): Step<VarsModel, VarsMessage> => {
  switch (message._tag) {
    case "Opened": {
      return {
        model: {
          ...model,
          form: VarFormTypes.Editing({ error: null, name: "", value: "" }),
          notice: "none",
        },
      };
    }

    case "Cancelled": {
      return {
        model: {
          ...model,
          form: VarFormTypes.Closed(),
        },
      };
    }

    case "NameChanged": {
      if (model.form._tag !== "Editing") {
        return { model };
      }

      return {
        model: {
          ...model,
          form: VarFormTypes.Editing({ ...model.form, name: message.value }),
        },
      };
    }

    case "ValueChanged": {
      if (model.form._tag !== "Editing") {
        return { model };
      }

      return {
        model: {
          ...model,
          form: VarFormTypes.Editing({ ...model.form, value: message.value }),
        },
      };
    }

    case "Submitted": {
      if (model.form._tag !== "Editing") {
        return { model };
      }

      const name = model.form.name.trim();

      if (!name) {
        return {
          model: {
            ...model,
            form: VarFormTypes.Editing({
              ...model.form,
              error: "Name is required",
            }),
          },
        };
      }

      return {
        cmd: keyed(
          `var:${model.envId}:${name}`,
          writeVar(model, name, model.form.value, message.close, message.reload)
        ),
        model: {
          ...model,
          form: VarFormTypes.Saving({
            name,
            value: model.form.value,
          }),
          notice: "none",
        },
      };
    }

    case "Saved": {
      return {
        model: {
          ...model,
          form: VarFormTypes.Closed(),
          notice: "saved",
        },
      };
    }

    case "SaveFailed": {
      if (model.form._tag !== "Saving") {
        return { model };
      }

      return {
        model: {
          ...model,
          form: VarFormTypes.Editing({
            error: message.error,
            name: model.form.name,
            value: model.form.value,
          }),
        },
      };
    }

    case "DeleteRequested": {
      if (model.list._tag === "Deleting") {
        return { model };
      }

      return {
        cmd: keyed(
          `var-del:${model.envId}:${message.name}`,
          deleteVar(model, message.name, message.reload)
        ),
        model: {
          ...model,
          list: VarListTypes.Deleting({ name: message.name }),
          notice: "none",
        },
      };
    }

    case "Deleted": {
      return {
        model: {
          ...model,
          list: VarListTypes.Idle(),
          notice: "saved",
        },
      };
    }

    case "DeleteFailed": {
      return {
        model: {
          ...model,
          list: VarListTypes.Failed({
            error: message.error,
            name: message.name,
          }),
        },
      };
    }

    default: {
      return { model };
    }
  }
};

// --- create environment ---------------------------------------------------

export type CreatePhase = Data.TaggedEnum<{
  Picking: Record<never, never>;
  Submitting: { readonly branch: string };
  Rejected: { readonly reason: string };
}>;

export const CreatePhaseTypes = Data.taggedEnum<CreatePhase>();

export interface CreateModel {
  /** `null` = nothing picked: the select shows its placeholder. */
  readonly branch: string | null;
  readonly phase: CreatePhase;
}

export type CreateMessage = Data.TaggedEnum<{
  BranchPicked: { readonly name: string };
  Created: Record<never, never>;
  Failed: { readonly error: string };
  Submitted: {
    readonly appId: string;
    readonly available: readonly string[];
    readonly onCreated: (env: RunnerEnvironment | null) => void;
  };
}>;

export const CreateMsg = Data.taggedEnum<CreateMessage>();

const createEnvironment = (
  appId: string,
  branch: string,
  onCreated: (env: RunnerEnvironment | null) => void
): Cmd<CreateMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: () =>
      api<RunnerEnvironment | null>("/api/environments/createEnvironment", {
        appId,
        branch,
      }),
  }).pipe(
    Effect.match({
      onFailure: (error) => CreateMsg.Failed({ error: error.message }),
      onSuccess: (env) => {
        // The dialog closes only after the runner answered: on `null` the
        // caller gets no environment to deep-link, and the machine says so
        // instead of closing silently.
        onCreated(env);

        if (env === null) {
          return CreateMsg.Failed({
            error:
              "Nothing was created — that branch already has an environment.",
          });
        }

        return CreateMsg.Created();
      },
    })
  );

/** The one transition function for the branch picker. */
export const updateCreate = (
  model: CreateModel,
  message: CreateMessage
): Step<CreateModel, CreateMessage> => {
  switch (message._tag) {
    case "BranchPicked": {
      if (model.phase._tag === "Submitting") {
        return { model };
      }

      return {
        model: {
          branch: message.name === "" ? null : message.name,
          phase: CreatePhaseTypes.Picking(),
        },
      };
    }

    case "Submitted": {
      if (model.phase._tag === "Submitting") {
        return { model };
      }

      const { branch } = model;

      // Refuse, never substitute: a branch the list no longer holds would
      // otherwise be silently replaced by the first one on screen.
      if (branch === null || !message.available.includes(branch)) {
        return {
          model: {
            ...model,
            phase: CreatePhaseTypes.Rejected({
              reason:
                branch === null
                  ? "Pick a branch first."
                  : "That branch is no longer available — pick another.",
            }),
          },
        };
      }

      return {
        cmd: keyed(
          `create-env:${message.appId}:${branch}`,
          createEnvironment(message.appId, branch, message.onCreated)
        ),
        model: { ...model, phase: CreatePhaseTypes.Submitting({ branch }) },
      };
    }

    case "Created": {
      if (model.phase._tag !== "Submitting") {
        return { model };
      }

      return { model: { ...model, phase: CreatePhaseTypes.Picking() } };
    }

    case "Failed": {
      if (model.phase._tag !== "Submitting") {
        return { model };
      }

      return {
        model: {
          ...model,
          phase: CreatePhaseTypes.Rejected({ reason: message.error }),
        },
      };
    }

    default: {
      return { model };
    }
  }
};
