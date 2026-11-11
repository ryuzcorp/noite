//! Settings view: custom hostnames this app answers on, with the DNS TXT
//! proof that keeps one tenant from claiming another's hostname.
//!
//! The add/verify/remove actions are one machine (`domains.machine.ts`): one
//! operation at a time, one attributed notice, and the "verified at once"
//! outcome comes from the response row — never inferred from prose.
import { defineApp } from "@ilha/model";
import type { UpdateResult } from "@ilha/model";

import { islandProps } from "../../island";
import { resourceValue, resourceError } from "../../resource";
import { domains } from "../../resources";
import type { AppRole } from "../../roles";
import { confirmDialog } from "../../ui/confirm";
import { CopyButton } from "../../ui/copy-button";
import { LoadError } from "../../ui/load-error";
import { ListSkeleton } from "../../ui/skeletons";
import { capabilities } from "../capabilities";
import { domainClaim } from "../lifecycle";
import {
  DomainNoticeTypes,
  DomainOpTypes,
  DomainsMsg,
  domainNoticeText,
  updateDomains,
} from "./domains.machine";
import type { DomainsMessage, DomainsModel } from "./domains.machine";
import { SettingsSection } from "./section";

const DomainsProps = islandProps<{
  appId: string;
  isAdmin: boolean;
}>("CustomDomainsPanel");

const DomainsApp = defineApp({
  init: (): UpdateResult<DomainsModel, DomainsMessage> => ({
    model: {
      appId: DomainsProps.read().appId,
      hostname: "",
      notice: DomainNoticeTypes.None(),
      op: DomainOpTypes.Idle(),
    } satisfies DomainsModel,
  }),
  update: updateDomains,
  view: (model, dispatch) => {
    const props = DomainsProps.read();
    const res = domains(props.appId);
    const rows = resourceValue(res.state()) ?? [];

    const reload = async (): Promise<void> => {
      await res.refetch();
    };

    const busy = model.op._tag !== "Idle";

    if (res.state()._tag === "Loading") {
      return (
        <SettingsSection section="domains">
          <ListSkeleton rows={2} />
        </SettingsSection>
      );
    }

    return (
      <SettingsSection section="domains">
        <p class="m-0 text-sm opacity-70">
          Serve this app from your own hostname. Only a verified hostname
          routes: add it, publish the TXT proof, then verify. Keep DNS pointed
          at this server; the edge issues the hostname's certificate on demand.
        </p>
        {model.notice._tag === "Failed" ? (
          <p class="text-error m-0 text-sm">{model.notice.error}</p>
        ) : (
          <LoadError error={resourceError(res.state())} />
        )}
        {rows.length === 0 ? (
          <p class="m-0 text-sm opacity-70">No custom hostnames yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((row) => {
              const claim = domainClaim(row);

              return (
                <li
                  key={`${row.appId}:${row.hostname}`}
                  class="border-base-300 flex flex-col gap-2 rounded border p-2 text-sm"
                >
                  <span class="flex flex-wrap items-center justify-between gap-2">
                    <span class="font-mono text-xs">{row.hostname}</span>
                    {claim._tag === "Verified" ? (
                      <span class="badge badge-success badge-sm">Verified</span>
                    ) : (
                      <span class="badge badge-warning badge-sm">Pending</span>
                    )}
                  </span>
                  {claim._tag === "Verified" ? null : (
                    <span class="flex flex-col gap-1 text-xs opacity-80">
                      <span>
                        Prove ownership with this TXT record, then press Verify:
                      </span>
                      <span class="flex flex-wrap items-center gap-1">
                        <code class="font-mono">
                          _noite-challenge.{row.hostname}
                        </code>
                        <CopyButton
                          iconOnly
                          label="Copy TXT record name"
                          value={`_noite-challenge.${row.hostname}`}
                        />
                      </span>
                      <span class="flex flex-wrap items-center gap-1">
                        <code class="font-mono break-all">{claim.token}</code>
                        <CopyButton
                          iconOnly
                          label="Copy TXT record value"
                          value={claim.token}
                        />
                      </span>
                    </span>
                  )}
                  {props.isAdmin ? (
                    <span class="flex flex-wrap gap-2">
                      {claim._tag === "Verified" ? null : (
                        <button
                          type="button"
                          class="btn btn-sm"
                          disabled={busy}
                          onclick={() => {
                            dispatch(
                              DomainsMsg.VerifyRequested({
                                hostname: row.hostname,
                                reload,
                              })
                            );
                          }}
                        >
                          {model.op._tag === "Verifying" &&
                          model.op.hostname === row.hostname
                            ? "Verifying…"
                            : "Verify"}
                        </button>
                      )}
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        disabled={busy}
                        onclick={async () => {
                          const reason = await confirmDialog({
                            confirmLabel: "Remove",
                            message: `${row.hostname} stops serving this app: the edge drops its route and certificate.`,
                            title: `Remove ${row.hostname}?`,
                          });

                          if (reason !== "confirm") {
                            return;
                          }

                          dispatch(
                            DomainsMsg.RemoveRequested({
                              hostname: row.hostname,
                              reload,
                            })
                          );
                        }}
                      >
                        {model.op._tag === "Removing" &&
                        model.op.hostname === row.hostname
                          ? "Removing…"
                          : "Remove"}
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {props.isAdmin ? (
          <form
            class="flex flex-wrap items-end gap-2"
            onsubmit={(event) => {
              event.preventDefault();
              dispatch(DomainsMsg.AddRequested({ reload }));
            }}
          >
            <fieldset class="fieldset grow">
              <label class="label" for="custom-domain-hostname">
                Hostname
              </label>
              <input
                id="custom-domain-hostname"
                class="input input-sm font-mono"
                value={model.hostname}
                disabled={busy}
                placeholder="app.example.com"
                oninput={(e) => {
                  dispatch(
                    DomainsMsg.HostnameChanged({ value: e.currentTarget.value })
                  );
                }}
              />
            </fieldset>
            <button type="submit" class="btn btn-sm" disabled={busy}>
              {model.op._tag === "Adding" ? "Adding…" : "Add domain"}
            </button>
          </form>
        ) : (
          <p class="m-0 text-sm opacity-70">
            Only an app admin can add or remove hostnames.
          </p>
        )}
        {model.notice._tag === "Added" || model.notice._tag === "Verified" ? (
          <p class="m-0 text-sm opacity-70">{domainNoticeText(model.notice)}</p>
        ) : null}
      </SettingsSection>
    );
  },
});

const DomainsIsland = DomainsProps.wrap(DomainsApp);

/** Custom domains: hostnames this app answers on, plus the one DNS step the
 * operator owns. The runner owns validation, collisions and the Caddyfile
 * route; the edge picks a verified hostname up on the next reconcile. */
export const CustomDomainsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => <DomainsIsland appId={appId} isAdmin={capabilities(myRole).admin} />;
