//! Custom-domain claim: add → pending TXT proof → verify, with remove. One
//! operation at a time and one attributed notice, instead of a shared `busy`
//! flag and a prose string derived from whatever row the response happened to
//! hold.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Adding: AddRequested (hostname non-empty)
//!   Idle --> Verifying: VerifyRequested
//!   Idle --> Removing: RemoveRequested
//!   Adding --> Idle: Added(verified?) — notice says which
//!   Verifying --> Idle: Verified
//!   Removing --> Idle: Removed
//!   Adding --> Idle: Failed(add)
//!   Verifying --> Idle: Failed(verify)
//!   Removing --> Idle: Failed(remove)
//! ```
//!
//! The code that reserves the hostname is one function; the response rows are
//! matched once for the `verified` outcome (a `single` tenancy verifies at
//! once), so the notice cannot claim "Saved and verified" for a pending claim.

/* oxlint-disable promise/prefer-await-to-callbacks -- a command factory takes message constructors, not continuation callbacks */
import { keyed } from "@ilha/model";
import type { Cmd } from "@ilha/model";
import { Data } from "effect";
import * as Effect from "effect/Effect";

import { api } from "../../api";
import { errorMessage } from "../../errors";
import type { RunnerDomain } from "../../runner";
import type { Step } from "../step";

export type DomainOp = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Adding: { readonly hostname: string };
  Verifying: { readonly hostname: string };
  Removing: { readonly hostname: string };
}>;

export const DomainOpTypes = Data.taggedEnum<DomainOp>();

export type DomainNotice = Data.TaggedEnum<{
  None: Record<never, never>;
  Added: { readonly verified: boolean };
  Verified: Record<never, never>;
  Failed: {
    readonly error: string;
    readonly op: "add" | "remove" | "verify";
  };
}>;

export const DomainNoticeTypes = Data.taggedEnum<DomainNotice>();

export interface DomainsModel {
  readonly appId: string;
  readonly hostname: string;
  readonly notice: DomainNotice;
  readonly op: DomainOp;
}

export type DomainsMessage = Data.TaggedEnum<{
  AddRequested: { readonly reload: () => Promise<void> };
  Added: { readonly hostname: string; readonly verified: boolean };
  Dismissed: Record<never, never>;
  Failed: {
    readonly error: string;
    readonly op: "add" | "remove" | "verify";
  };
  HostnameChanged: { readonly value: string };
  RemoveRequested: {
    readonly hostname: string;
    readonly reload: () => Promise<void>;
  };
  Removed: Record<never, never>;
  VerifyRequested: {
    readonly hostname: string;
    readonly reload: () => Promise<void>;
  };
  Verified: Record<never, never>;
}>;

export const DomainsMsg = Data.taggedEnum<DomainsMessage>();

const normalizeHostname = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\.+$/u, "");

const addDomain = (
  model: DomainsModel,
  hostname: string,
  reload: () => Promise<void>
): Cmd<DomainsMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: async () => {
      const rows = await api<RunnerDomain[]>("/api/domains/addDomain", {
        appId: model.appId,
        hostname,
      });

      await reload();

      return rows;
    },
  }).pipe(
    Effect.match({
      onFailure: (error) =>
        DomainsMsg.Failed({ error: error.message, op: "add" }),
      onSuccess: (rows) => {
        const claimed = rows.find(
          (row) => row.hostname === normalizeHostname(hostname)
        );

        return DomainsMsg.Added({
          hostname,
          verified: claimed?.status === "verified",
        });
      },
    })
  );

const verifyDomain = (
  model: DomainsModel,
  hostname: string,
  reload: () => Promise<void>
): Cmd<DomainsMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: async () => {
      await api<RunnerDomain[]>("/api/domains/verifyDomain", {
        appId: model.appId,
        hostname,
      });
      await reload();
    },
  }).pipe(
    Effect.match({
      onFailure: (error) =>
        DomainsMsg.Failed({ error: error.message, op: "verify" }),
      onSuccess: () => DomainsMsg.Verified(),
    })
  );

const removeDomain = (
  model: DomainsModel,
  hostname: string,
  reload: () => Promise<void>
): Cmd<DomainsMessage> =>
  Effect.tryPromise({
    catch: (error) => new Error(errorMessage(error)),
    try: async () => {
      await api<{ ok: true }>("/api/domains/removeDomain", {
        appId: model.appId,
        hostname,
      });
      await reload();
    },
  }).pipe(
    Effect.match({
      onFailure: (error) =>
        DomainsMsg.Failed({ error: error.message, op: "remove" }),
      onSuccess: () => DomainsMsg.Removed(),
    })
  );

/** The one transition function for the custom-domain panel. */
export const updateDomains = (
  model: DomainsModel,
  message: DomainsMessage
): Step<DomainsModel, DomainsMessage> => {
  switch (message._tag) {
    case "HostnameChanged": {
      return { model: { ...model, hostname: message.value } };
    }

    case "AddRequested": {
      if (model.op._tag !== "Idle") {
        return { model };
      }

      const hostname = normalizeHostname(model.hostname);

      if (hostname === "" || !/\.[^.]/u.test(hostname)) {
        return {
          model: {
            ...model,
            notice: DomainNoticeTypes.Failed({
              error: "Enter a valid hostname first.",
              op: "add",
            }),
          },
        };
      }

      return {
        cmd: keyed(
          `domain-add:${model.appId}:${hostname}`,
          addDomain(model, hostname, message.reload)
        ),
        model: {
          ...model,
          notice: DomainNoticeTypes.None(),
          op: DomainOpTypes.Adding({ hostname }),
        },
      };
    }

    case "VerifyRequested": {
      if (model.op._tag !== "Idle") {
        return { model };
      }

      return {
        cmd: keyed(
          `domain-verify:${model.appId}:${message.hostname}`,
          verifyDomain(model, message.hostname, message.reload)
        ),
        model: {
          ...model,
          notice: DomainNoticeTypes.None(),
          op: DomainOpTypes.Verifying({ hostname: message.hostname }),
        },
      };
    }

    case "RemoveRequested": {
      if (model.op._tag !== "Idle") {
        return { model };
      }

      return {
        cmd: keyed(
          `domain-remove:${model.appId}:${message.hostname}`,
          removeDomain(model, message.hostname, message.reload)
        ),
        model: {
          ...model,
          notice: DomainNoticeTypes.None(),
          op: DomainOpTypes.Removing({ hostname: message.hostname }),
        },
      };
    }

    case "Added": {
      return {
        model: {
          ...model,
          hostname: "",
          notice: DomainNoticeTypes.Added({ verified: message.verified }),
          op: DomainOpTypes.Idle(),
        },
      };
    }

    case "Verified": {
      return {
        model: {
          ...model,
          notice: DomainNoticeTypes.Verified(),
          op: DomainOpTypes.Idle(),
        },
      };
    }

    case "Removed": {
      return {
        model: {
          ...model,
          notice: DomainNoticeTypes.None(),
          op: DomainOpTypes.Idle(),
        },
      };
    }

    case "Failed": {
      return {
        model: {
          ...model,
          notice: DomainNoticeTypes.Failed({
            error: message.error,
            op: message.op,
          }),
          op: DomainOpTypes.Idle(),
        },
      };
    }

    case "Dismissed": {
      return { model: { ...model, notice: DomainNoticeTypes.None() } };
    }

    default: {
      return { model };
    }
  }
};

/** The notice text; the machine owns the distinction between a pending claim
 * and one verified at once. */
export const domainNoticeText = (notice: DomainNotice): string => {
  switch (notice._tag) {
    case "Added": {
      return notice.verified
        ? "Saved and verified. Point an A/AAAA record for it at this server; the certificate issues on the first visit."
        : "Claim created — still pending. Add the TXT record below, then press Verify.";
    }

    case "Verified": {
      return "Verified. The edge picks the hostname up within seconds.";
    }

    case "Failed": {
      return notice.error;
    }

    default: {
      return "";
    }
  }
};
