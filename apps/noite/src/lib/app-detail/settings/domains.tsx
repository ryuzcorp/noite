//! Settings panel: custom hostnames this app answers on.

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { domains } from "../../resources";
import type { AppRole } from "../../roles";
import { addDomain, removeDomain } from "../../server/domains.server";
import { LoadError } from "../../ui/load-error";
import { SectionSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

/** Custom domains: hostnames this app answers on, plus the one DNS step the
 * operator owns. The runner owns validation, collisions and the Caddyfile
 * route; adding a hostname here reserves it and the edge picks it up on the
 * next reconcile (a few seconds). */
export const CustomDomainsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = domains(appId);
  const err = atom("");
  const note = atom("");
  const busy = atom(false);
  const hostname = atom("");
  const isAdmin = myRole === "admin";

  const reload = async () => {
    try {
      await res.refetch();
      err.set("");
    } catch (error) {
      err.set(errorMessage(error));
    }
  };

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = hostname().trim();
    if (!value) {
      note.set("Enter a hostname first.");
      return;
    }
    busy.set(true);
    note.set("");
    try {
      await addDomain({ appId, hostname: value });
      hostname.set("");
      note.set(
        "Saved. Point an A/AAAA record for it at this server; the certificate issues on the first visit."
      );
      await reload();
    } catch (error) {
      note.set(errorMessage(error));
    }
    busy.set(false);
  };

  const removeDomainRow = async (value: string) => {
    busy.set(true);
    note.set("");
    try {
      await removeDomain({ appId, hostname: value });
      await reload();
    } catch (error) {
      note.set(errorMessage(error));
    }
    busy.set(false);
  };

  const rows = res.data() ?? [];
  if (res.loading() && res.data() === undefined) {
    return <SectionSkeleton lines={2} />;
  }
  return (
    <SettingsSection>
      <h3 class="m-0 text-lg font-semibold">Custom Domain</h3>
      <p class="m-0 text-sm opacity-70">
        Serve this app from your own hostname. Keep DNS pointed at this server;
        the edge routes the hostname and issues its certificate on demand.
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      {err() ? null : <LoadError error={res.error()} />}
      {rows.length === 0 ? (
        <p class="m-0 text-sm opacity-70">No custom hostnames yet.</p>
      ) : (
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((row) => (
            <li
              key={row.hostname}
              class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
            >
              <span class="font-mono text-xs">{row.hostname}</span>
              {isAdmin ? (
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={busy()}
                  onclick={() => {
                    void removeDomainRow(row.hostname);
                  }}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {isAdmin ? (
        <form class="flex flex-wrap items-end gap-2" onsubmit={add}>
          <fieldset class="fieldset grow">
            <label class="label" for="custom-domain-hostname">
              Hostname
            </label>
            <input
              id="custom-domain-hostname"
              class="input input-sm font-mono"
              value={hostname()}
              placeholder="app.example.com"
              oninput={(e) => {
                hostname.set(e.currentTarget.value);
              }}
            />
          </fieldset>
          <button type="submit" class="btn btn-sm" disabled={busy()}>
            Add domain
          </button>
        </form>
      ) : (
        <p class="m-0 text-sm opacity-70">
          Only an app admin can add or remove hostnames.
        </p>
      )}
      {note() ? <p class="m-0 text-sm opacity-70">{note()}</p> : null}
    </SettingsSection>
  );
};
