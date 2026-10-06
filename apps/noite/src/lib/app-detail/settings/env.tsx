//! Settings panel: the app's environment variables (and `FLAG_` toggles).

import { atom } from "ilha";

import { errorMessage } from "../../errors";
import { envVars } from "../../resources";
import type { AppRole } from "../../roles";
import { deleteEnv, envDotVars, setEnv } from "../../server/env.server";
import type { EnvVarView } from "../../server/env.server";
import { Dialog } from "../../ui/dialog";
import { LoadError } from "../../ui/load-error";
import { ListSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

/** Tenant env vars (`.dev.vars` model): UI-set vars reach build, release
 * command, and fleet env. Reads are view-gated, writes admin-gated
 * server-side; the form locks for non-admins. Download mirrors the file
 * local dev expects (Cloudflare `.dev.vars` convention). Names starting
 * with `FLAG_` render as on/off toggles (`1`/`0`). */

/** A `FLAG_<NAME>` row is a feature flag: the toggle writes `1`/`0`. */
const isFlag = (name: string) => name.startsWith("FLAG_");

export const EnvVarsPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = envVars(appId);
  const rows = res.data() ?? [];
  const err = atom("");
  const busy = atom(false);
  const dialogOpen = atom(false);
  const newVarName = atom("");
  const newVarValue = atom("");
  const isAdmin = myRole === "admin";
  const reload = async () => {
    try {
      await res.refetch();
      err.set("");
    } catch (error) {
      err.set(errorMessage(error));
    }
  };
  const toggleFlag = (row: EnvVarView) => {
    if (!isAdmin || busy()) {
      return;
    }
    busy.set(true);
    void (async () => {
      try {
        await setEnv({
          appId,
          name: row.name,
          value: row.value === "1" ? "0" : "1",
        });
        await reload();
      } catch (error) {
        err.set(errorMessage(error));
      }
      busy.set(false);
    })();
  };
  const openModal = () => {
    err.set("");
    newVarName.set("");
    newVarValue.set("");
    dialogOpen.set(true);
  };
  const submit = () => {
    if (busy()) {
      return;
    }
    // Names starting with FLAG_ are saved verbatim: the list renders
    // them as boolean toggles (checked when the value is "1").
    const raw = newVarName().trim();
    if (!raw) {
      err.set("Name is required");
      return;
    }
    const finalValue = newVarValue();
    busy.set(true);
    err.set("");
    void (async () => {
      try {
        await setEnv({ appId, name: raw, value: finalValue });
        newVarName.set("");
        newVarValue.set("");
        dialogOpen.set(false);
        await reload();
      } catch (error) {
        err.set(errorMessage(error));
      }
      busy.set(false);
    })();
  };
  return (
    <SettingsSection>
      <div class="flex items-center justify-between gap-2">
        <h3 class="m-0 text-lg font-semibold">Environment</h3>
        {isAdmin ? (
          <span class="flex items-center gap-2">
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                void (async () => {
                  try {
                    const text = await envDotVars(appId);
                    const url = URL.createObjectURL(
                      new Blob([text], { type: "text/plain" })
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = ".dev.vars";
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (error) {
                    err.set(errorMessage(error));
                  }
                })();
              }}
            >
              Download .dev.vars
            </button>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              onclick={() => {
                openModal();
              }}
            >
              Add Variable
            </button>
          </span>
        ) : null}
      </div>
      <p class="m-0 text-sm opacity-70">
        Variables reach the build, the release command, and the fleet. Values
        are hidden after saving; names starting with <code>FLAG_</code> render
        as on/off toggles (<code>1</code>/<code>0</code>).
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      {err() ? null : <LoadError error={res.error()} />}
      {res.loading() && res.data() === undefined ? (
        <ListSkeleton rows={2} />
      ) : null}
      {rows.length === 0 && !(res.loading() && res.data() === undefined) ? (
        <p class="m-0 text-sm opacity-70">
          No variables yet — add one to configure the build, the release
          command, or the fleet.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul class="list bg-base-100 dark:bg-base-200 w-full">
          {rows.map((r) => (
            <li
              key={r.name}
              class="list-row flex items-center justify-between gap-2"
            >
              {isFlag(r.name) ? (
                <span class="flex min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    class="toggle toggle-sm"
                    aria-label={`Toggle ${r.name}`}
                    checked={r.value === "1"}
                    disabled={!isAdmin || busy()}
                    onchange={() => {
                      toggleFlag(r);
                    }}
                  />
                  <span class="font-mono text-sm">{r.name}</span>
                </span>
              ) : (
                <span class="font-mono text-sm">{r.name}</span>
              )}
              <span class="flex items-center gap-2">
                {isFlag(r.name) ? null : (
                  <span class="text-base-content/60 font-mono text-xs">
                    ••••••
                  </span>
                )}
                {isAdmin ? (
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost shrink-0"
                    disabled={busy()}
                    onclick={() => {
                      // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive deletes.
                      if (!confirm(`Delete ${r.name}?`)) {
                        return;
                      }
                      busy.set(true);
                      void (async () => {
                        try {
                          await deleteEnv({ appId, name: r.name });
                          await reload();
                        } catch (error) {
                          err.set(errorMessage(error));
                        }
                        busy.set(false);
                      })();
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {isAdmin ? null : (
        <p class="m-0 text-sm opacity-70">
          Only admins can add or remove variables.
        </p>
      )}
      <Dialog open={dialogOpen} class="modal">
        <div class="modal-box bg-base-100 dark:bg-base-200">
          <h3 class="m-0 text-lg font-bold">Add Variable</h3>
          <p class="m-0 py-2 text-sm opacity-80">
            Names starting with <code>FLAG_</code> become on/off toggles in the
            list. Other values are hidden after saving and can't be viewed
            again.
          </p>
          <fieldset class="fieldset w-full">
            <label class="label" for="newvar-name">
              Name
            </label>
            <input
              id="newvar-name"
              class="input input-sm w-full font-mono"
              placeholder="DATABASE_URL or FLAG_DARK_LAUNCH"
              value={newVarName()}
              oninput={(e) => {
                newVarName.set(e.currentTarget.value);
              }}
            />
          </fieldset>
          <fieldset class="fieldset w-full">
            <label class="label" for="newvar-value">
              Value
            </label>
            <input
              id="newvar-value"
              class="input input-sm w-full font-mono"
              placeholder="postgres://… (flags use 1/0)"
              value={newVarValue()}
              oninput={(e) => {
                newVarValue.set(e.currentTarget.value);
              }}
            />
          </fieldset>
          {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              disabled={busy()}
              onclick={() => {
                dialogOpen.set(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-sm btn-neutral"
              disabled={busy()}
              onclick={() => {
                submit();
              }}
            >
              {busy() ? "Saving…" : "Add"}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button aria-label="Close dialog" disabled={busy()}>
            close
          </button>
        </form>
      </Dialog>
    </SettingsSection>
  );
};
