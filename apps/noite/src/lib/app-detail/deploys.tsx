//! Deploy history: header dropdown + SSE list.
import { atom } from "ilha";

import { rollback } from "../apps.server";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { decodeDeploys, deploysUrl, feedKeys, liveFeed } from "../feeds";
import { Check, ChevronDown, ChevronUp, CloudUpload, Copy } from "../icons";
import { appDetail, deployLog } from "../resources";
import type { RunnerDeploy } from "../runner";
import { ListSkeleton } from "../skeletons";
import { RuntimeLogs } from "./logs";

export const deployBadge = (status: string) => {
  let tone = "badge-ghost";
  if (status === "success") {
    tone = "badge-primary";
  } else if (status === "failed") {
    tone = "badge-error";
  } else if (status === "building" || status === "deploying") {
    tone = "badge-warning";
  }
  return <span class={`badge badge-sm ${tone}`}>{status}</span>;
};

/** Deploy (git remote) card dropdown. Lives in the page header next to
 * Code so it works on every tab; loads its own detail via the shared
 * resource. CSS-only dropdown (focus-based) — no visibility atom needed. */
export const DeployDropdown = ({ appId }: { appId: string }) => {
  const info = appDetail(appId).data();
  const copied = atom(false);
  const redeploying = atom(false);
  const redeployError = atom("");
  if (!info) {
    return null;
  }
  const canPush = info.myRole === "push" || info.myRole === "admin";
  const copyRemote = async () => {
    try {
      await navigator.clipboard.writeText(info.gitRemote);
      copied.set(true);
      setTimeout(() => {
        copied.set(false);
      }, 1500);
    } catch {
      // Clipboard API unavailable — the remote text stays selectable.
    }
  };
  return (
    <div class="dropdown dropdown-end">
      <div tabindex={0} role="button" class="btn btn-sm btn-neutral">
        <span class="inline-flex items-center gap-1">
          <CloudUpload />
          Deploy
        </span>
      </div>
      <div
        tabindex={0}
        class="dropdown-content card bg-base-100 dark:bg-base-200 border-base-300 z-10 w-80 border shadow-md"
      >
        <div class="card-body gap-4">
          <h3 class="card-title m-0 text-base">Deploy</h3>
          <div class="flex items-center gap-2">
            <code class="bg-base-200 block min-w-0 flex-1 overflow-x-auto rounded p-2 font-mono text-xs">
              {info.gitRemote}
            </code>
            <button
              type="button"
              class="btn btn-sm shrink-0"
              title={copied() ? "Copied" : "Copy git remote"}
              aria-label={copied() ? "Copied" : "Copy git remote"}
              onclick={() => {
                void copyRemote();
              }}
            >
              {copied() ? <Check /> : <Copy />}
            </button>
          </div>
          <p class="m-0 text-sm opacity-80">
            Stock Git over HTTP — push <code>main</code> to deploy. Auth:{" "}
            <code>username={info.username}</code>, password = API key from{" "}
            <a href="/account" class="link">
              Account
            </a>
            .
          </p>
          {canPush ? null : (
            <p class="m-0 text-sm opacity-70">
              Need <code>push</code> or <code>admin</code> to push;{" "}
              <code>view</code> can fetch.
            </p>
          )}
          {canPush && info.app.lastDeploySha ? (
            <div class="flex flex-col gap-2">
              {redeployError() ? (
                <p class="text-error m-0 text-sm">{redeployError()}</p>
              ) : null}
              <button
                type="button"
                class="btn btn-sm btn-neutral w-full"
                disabled={redeploying()}
                title="Re-run the pipeline at the current commit with the latest env vars and flags"
                onclick={() => {
                  const sha = info.app.lastDeploySha;
                  if (!sha) {
                    return;
                  }
                  redeploying.set(true);
                  redeployError.set("");
                  void (async () => {
                    try {
                      await rollback({ appId, sha });
                    } catch (error) {
                      redeployError.set(errorMessage(error));
                    }
                    redeploying.set(false);
                  })();
                }}
              >
                {redeploying()
                  ? "Redeploying…"
                  : `Redeploy ${(info.app.lastDeploySha ?? "").slice(0, 12)}`}
              </button>
              <p class="m-0 text-xs opacity-70">
                Picks up the latest env vars and flags. Progress shows in
                Deployments.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** A finished deploy's build log, fetched once per deploy id when its tab
 * opens (T1.7). The stream omits finished rows' logs, so this resource —
 * cached forever, since finished deploys never change — is the only read. */
const FinishedBuildLog = ({
  appId,
  deployId,
}: {
  appId: string;
  deployId: string;
}) => {
  const res = deployLog(appId, deployId);
  const log = res.data()?.log;
  return (
    <div class="bg-base-200 rounded-lg p-3">
      <pre class="max-h-64 overflow-auto rounded font-mono text-xs whitespace-pre-wrap">
        {log ?? "(loading build log…)"}
      </pre>
    </div>
  );
};

/** Build-log pane for one deploy row: deployment logs, the live log of the
 * in-flight newest row (the stream carries it), or the on-demand fetch of
 * a finished row (the stream omits it; cached forever). */
const BuildLogPane = ({
  appId,
  d,
  tab,
}: {
  appId: string;
  d: RunnerDeploy;
  tab: "build" | "deploy";
}) => {
  if (tab === "deploy") {
    return (
      <div class="bg-base-200 rounded-lg p-3">
        <RuntimeLogs appId={appId} />
      </div>
    );
  }
  if (d.log) {
    return (
      <div class="bg-base-200 rounded-lg p-3">
        <pre class="max-h-64 overflow-auto rounded font-mono text-xs whitespace-pre-wrap">
          {d.log}
        </pre>
      </div>
    );
  }
  return <FinishedBuildLog appId={appId} deployId={d.id} />;
};

const DeployRow = ({
  appId,
  currentSha,
  d,
}: {
  appId: string;
  currentSha: string | null;
  d: RunnerDeploy;
}) => {
  // Atom-driven expansion: the log is a sibling <li> (block layout, full
  // width by construction) instead of a grid child — immune to list-row
  // span subtleties. The current deployment starts expanded.
  const open = atom(!!d.sha && d.sha === currentSha);
  const logTab = atom<"build" | "deploy">("deploy");
  const rolling = atom(false);
  const rollError = atom("");
  const canRollBack = d.status === "success" && !!d.sha && d.sha !== currentSha;
  return (
    <>
      <li class="list-row">
        <div>{deployBadge(d.status)}</div>
        <div>
          <div class="font-mono text-sm">
            {d.sha ? d.sha.slice(0, 12) : "—"}
          </div>
          <div class="text-base-content/70 text-xs">
            {formatDateTime(d.createdAt)}
          </div>
        </div>
        {rollError() ? (
          <p class="text-error m-0 text-xs">{rollError()}</p>
        ) : null}
        {canRollBack ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost shrink-0"
            disabled={rolling()}
            onclick={() => {
              if (!d.sha) {
                return;
              }
              // oxlint-disable-next-line no-alert -- native confirm dialog is the requirement for destructive rollback.
              if (!confirm(`Roll back to ${d.sha.slice(0, 12)}?`)) {
                return;
              }
              rolling.set(true);
              rollError.set("");
              void (async () => {
                try {
                  // SAFETY: canRollBack guarantees d.sha is a non-empty string here; the early return above narrows it for the linter.
                  await rollback({ appId, sha: d.sha as string });
                } catch (error) {
                  rollError.set(errorMessage(error));
                }
                rolling.set(false);
              })();
            }}
          >
            {rolling() ? "Rolling back…" : "Roll back"}
          </button>
        ) : null}
        <button
          type="button"
          class="btn btn-sm btn-ghost shrink-0"
          aria-expanded={open()}
          onclick={() => {
            open.set(!open());
          }}
        >
          <span class="inline-flex items-center gap-1">
            {open() ? "Hide logs" : "View logs"}
            {open() ? <ChevronUp /> : <ChevronDown />}
          </span>
        </button>
      </li>
      {open() ? (
        <li class="flex flex-col gap-2 px-4 pb-4">
          <div role="tablist" class="tabs tabs-border w-fit">
            <button
              type="button"
              role="tab"
              aria-selected={logTab() === "deploy"}
              class={`tab ${logTab() === "deploy" ? "tab-active" : ""}`}
              onclick={() => {
                logTab.set("deploy");
              }}
            >
              Deployment logs
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={logTab() === "build"}
              class={`tab ${logTab() === "build" ? "tab-active" : ""}`}
              onclick={() => {
                logTab.set("build");
              }}
            >
              Build logs
            </button>
          </div>
          <BuildLogPane appId={appId} d={d} tab={logTab()} />
        </li>
      ) : null}
    </>
  );
};

/** Deploy history over SSE: skeleton until the first frame, then the event
 * stream pushes updates — no polling, and rows never remount underneath
 * an open log. */
export const DeployList = ({ appId }: { appId: string }) => {
  const feed = liveFeed(
    feedKeys.deploys(appId),
    deploysUrl(appId),
    decodeDeploys
  );
  const items = (): RunnerDeploy[] => feed.latest() ?? [];
  const loaded = (): boolean =>
    feed.latest() !== undefined || feed.status() === "open";
  const retrying = (): boolean => feed.status() === "retrying";
  const currentSha = appDetail(appId).data()?.app.lastDeploySha ?? null;
  return (
    <div class="flex w-full flex-col gap-4">
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          Deploy stream disconnected — retrying…
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Deployments</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
        </li>
        {!loaded() && items().length === 0 && !retrying() ? (
          <li class="px-4 pt-2 pb-4">
            <ListSkeleton rows={2} />
          </li>
        ) : null}
        {loaded() && items().length === 0 && !retrying() ? (
          <li class="text-base-content/70 px-4 pt-2 pb-4 text-sm">
            No deployments yet. Push to main to trigger one.
          </li>
        ) : null}
        {items().map((d) => (
          <DeployRow key={d.id} appId={appId} currentSha={currentSha} d={d} />
        ))}
      </ul>
    </div>
  );
};
