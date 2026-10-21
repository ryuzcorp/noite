//! Settings panel: the browser error-reporting DSN and key rotation.

import { atom } from "ilha";

import { api } from "../../api";
import { errorMessage } from "../../errors";
import { ingestKey } from "../../resources";
import type { AppRole } from "../../roles";
import type { RunnerIngestKey } from "../../runner";
import { LoadError } from "../../ui/load-error";
import { SectionSkeleton } from "../../ui/skeletons";
import { SettingsSection } from "./section";

/** Error reporting (Sentry-compatible browser ingest): the DSN the browser
 * SDK posts envelopes to, plus key rotation for app admins. Viewers see the
 * DSN — the key is public by design, it only submits errors. */
export const ErrorReportingPanel = ({
  appId,
  myRole,
}: {
  appId: string;
  myRole: AppRole;
}) => {
  const res = ingestKey(appId);
  const err = atom("");
  const note = atom("");
  const busy = atom(false);
  const isAdmin = myRole === "admin";

  const current = res.data();

  if (res.loading() && current === undefined) {
    return <SectionSkeleton lines={2} />;
  }

  if (!current) {
    return (
      <SettingsSection>
        <h3 class="m-0 text-lg font-semibold">Error reporting</h3>
        <LoadError error={res.error()} />
      </SettingsSection>
    );
  }

  const dsn = `https://${current.key}@${window.location.host}/${current.projectId}`;

  const snippet = `import * as Sentry from "@sentry/browser";

Sentry.init({
  dsn: "${dsn}",
  // release: APP_VERSION, // optional: surfaces per-release in the Errors tab
});`;

  const rotate = async () => {
    busy.set(true);
    err.set("");
    note.set("");

    try {
      await api<RunnerIngestKey>("/api/errors/rotateIngestKey", appId);
      await res.refetch();
      note.set(
        "Key rotated. Redeploy any page still reporting with the old DSN."
      );
    } catch (error) {
      err.set(errorMessage(error));
    }

    busy.set(false);
  };

  return (
    <SettingsSection>
      <h3 class="m-0 text-lg font-semibold">Error reporting</h3>
      <p class="m-0 text-sm opacity-70">
        Report browser errors with any Sentry-compatible SDK. The DSN carries
        this app&apos;s project id and ingest key — the key is public by design,
        it only submits errors.
      </p>
      <p class="bg-base-200 m-0 rounded p-3 font-mono text-xs break-all">
        {dsn}
      </p>
      {err() ? <p class="text-error m-0 text-sm">{err()}</p> : null}
      {isAdmin ? (
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy()}
            onclick={() => {
              void rotate();
            }}
          >
            {busy() ? "Rotating…" : "Rotate key"}
          </button>
          {note() ? <p class="m-0 text-sm opacity-70">{note()}</p> : null}
        </div>
      ) : (
        <p class="m-0 text-sm opacity-70">
          Only an app admin can rotate the ingest key.
        </p>
      )}
      <pre class="bg-base-300 m-0 overflow-x-auto rounded p-3 font-mono text-xs">
        {snippet}
      </pre>
    </SettingsSection>
  );
};
