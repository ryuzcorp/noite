//! Settings panel: custom hostnames this app answers on, with the DNS TXT
//! proof that keeps one tenant from claiming another's hostname.

import { atom } from "ilha";

import { api } from "../../api";
import { errorMessage } from "../../errors";
import { domains } from "../../resources";
import type { AppRole } from "../../roles";
import type { RunnerDomain } from "../../runner";
import { CopyButton } from "../../ui/copy-button";
import { LoadError } from "../../ui/load-error";
import { SectionSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

/** Custom domains: hostnames this app answers on, plus the one DNS step the
 * operator owns. A new claim is pending until the TXT record at
 * `_noite-challenge.<hostname>` proves ownership (the Verify button checks
 * it); only verified hostnames route, resolve and mint certificates. In
 * `single` tenancy the claim verifies at once. The runner owns validation,
 * collisions and the Caddyfile route; the edge picks a verified hostname up
 * on the next reconcile (a few seconds). */
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
      const rows = await api<RunnerDomain[]>("/api/domains/addDomain", {
        appId,
        hostname: value,
      });

      hostname.set("");

      const claimed = rows.find(
        (row) => row.hostname === value.toLowerCase().replace(/\.+$/u, "")
      );

      note.set(
        claimed !== undefined && claimed.status !== "verified"
          ? "Claim created — still pending. Add the TXT record below, then press Verify."
          : "Saved and verified. Point an A/AAAA record for it at this server; the certificate issues on the first visit."
      );
      await reload();
    } catch (error) {
      note.set(errorMessage(error));
    }

    busy.set(false);
  };

  const verifyRow = async (value: string) => {
    busy.set(true);
    note.set("");

    try {
      await api<RunnerDomain[]>("/api/domains/verifyDomain", {
        appId,
        hostname: value,
      });
      note.set("Verified. The edge picks the hostname up within seconds.");
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
      await api<{ ok: true }>("/api/domains/removeDomain", {
        appId,
        hostname: value,
      });
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
        Serve this app from your own hostname. Only a verified hostname routes:
        add it, publish the TXT proof, then verify. Keep DNS pointed at this
        server; the edge issues the hostname's certificate on demand.
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      {err() ? null : <LoadError error={res.error()} />}
      {rows.length === 0 ? (
        <p class="m-0 text-sm opacity-70">No custom hostnames yet.</p>
      ) : (
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((row) => (
            <li
              key={`${row.appId}:${row.hostname}`}
              class="border-base-300 flex flex-col gap-2 rounded border p-2 text-sm"
            >
              <span class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-xs">{row.hostname}</span>
                {row.status === "verified" ? (
                  <span class="badge badge-success badge-sm">Verified</span>
                ) : (
                  <span class="badge badge-warning badge-sm">Pending</span>
                )}
              </span>
              {row.status === "verified" ? null : (
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
                    <code class="font-mono break-all">{row.token}</code>
                    <CopyButton
                      iconOnly
                      label="Copy TXT record value"
                      value={row.token}
                    />
                  </span>
                </span>
              )}
              {isAdmin ? (
                <span class="flex flex-wrap gap-2">
                  {row.status === "verified" ? null : (
                    <button
                      type="button"
                      class="btn btn-sm"
                      disabled={busy()}
                      onclick={() => {
                        void verifyRow(row.hostname);
                      }}
                    >
                      Verify
                    </button>
                  )}
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
                </span>
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
