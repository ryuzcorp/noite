//! Deploy history: header dropdown + SSE list.
import { Link } from "@ilha/void";
import { atom } from "ilha";

import { api } from "../api";
import { appHost, appUrl } from "../apps/identity";
import { formatDateTime } from "../dates";
import { errorMessage } from "../errors";
import { decodeDeploys, deploysUrl, feedKeys, liveFeed } from "../feeds";
import { appDetail, deployLog, environments } from "../resources";
import type { AppRole } from "../roles";
import type { RunnerDeploy } from "../runner";
import { searchParam } from "../search-param";
import { confirmDialog } from "../ui/confirm";
import { CopyButton } from "../ui/copy-button";
import { ChevronDown, ChevronUp, CloudUpload, Plus } from "../ui/icons";
import { LoadError } from "../ui/load-error";
import { ListSkeleton } from "../ui/skeletons";
import {
  CreateEnvironmentDialog,
  DeployGroupMeta,
  EnvironmentGroup,
} from "./environments";
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
  const redeploying = atom(false);
  const redeployError = atom("");

  if (!info) {
    return null;
  }

  const canPush = info.myRole === "push" || info.myRole === "admin";

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
            <CopyButton
              class="btn btn-sm shrink-0"
              iconOnly
              label="Copy git remote"
              value={info.gitRemote}
            />
          </div>
          <p class="m-0 text-sm opacity-80">
            Stock Git over HTTP — push <code>main</code> to deploy. Auth:{" "}
            <code>username={info.username}</code>, password = API key from{" "}
            <Link href="/account" class="link">
              Account
            </Link>
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
                      await api<{ ok: true }>("/api/apps/rollback", {
                        appId,
                        sha,
                      });
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
  environmentId,
  tab,
}: {
  appId: string;
  d: RunnerDeploy;
  /** The row's environment ("" = production): its fleet's runtime logs. */
  environmentId: string;
  tab: "build" | "deploy";
}) => {
  if (tab === "deploy") {
    return (
      <div class="bg-base-200 rounded-lg p-3">
        <RuntimeLogs appId={appId} environmentId={environmentId} />
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
  environmentId,
  live,
}: {
  appId: string;
  currentSha: string | null;
  d: RunnerDeploy;
  /** The row's environment ("" = production). */
  environmentId: string;
  /** The deploy serving traffic now, which starts expanded. */
  live: boolean;
}) => {
  // Atom-driven expansion: the log is a sibling <li> (block layout, full
  // width by construction) instead of a grid child — immune to list-row
  // span subtleties. Until the reader toggles it, the row follows `live`:
  // that is only known once both the app's live sha and the feed's rows are
  // in, in either order, so a row seeded at mount stayed collapsed whenever
  // the rows came first.
  const toggled = atom<boolean | null>(null);
  const open = (): boolean => toggled() ?? live;
  const logTab = atom<"build" | "deploy">("deploy");
  const rolling = atom(false);
  const rollError = atom("");

  // Roll back re-runs production's pipeline at that sha, so it belongs to
  // production rows only — an environment row must never deploy its sha to
  // production (its header's Redeploy covers redeploying the environment).
  const canRollBack =
    environmentId === "" &&
    d.status === "success" &&
    !!d.sha &&
    d.sha !== currentSha;

  return (
    <>
      <li class="list-row">
        <div>{deployBadge(d.status)}</div>
        <div>
          <div class="font-mono text-sm">
            {d.sha ? (
              <Link
                class="link link-hover"
                href={`/apps/${appId}/source/commit/${d.sha}`}
                title={d.sha}
              >
                {d.sha.slice(0, 12)}
              </Link>
            ) : (
              "—"
            )}
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
            onclick={async () => {
              const { sha } = d;

              if (!sha) {
                return;
              }

              const ok = await confirmDialog({
                confirmLabel: "Roll back",
                title: `Roll back to ${sha.slice(0, 12)}?`,
              });

              if (!ok) {
                return;
              }

              rolling.set(true);
              rollError.set("");

              try {
                await api<{ ok: true }>("/api/apps/rollback", { appId, sha });
              } catch (error) {
                rollError.set(errorMessage(error));
              }

              rolling.set(false);
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
            toggled.set(!open());
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
          <BuildLogPane
            appId={appId}
            d={d}
            environmentId={environmentId}
            tab={logTab()}
          />
        </li>
      ) : null}
    </>
  );
};

/** One environment's deploy history over SSE: skeleton until the first frame,
 * then the event stream pushes updates — no polling, and rows never remount
 * underneath an open log. `environmentId` is `""` for production. */
const DeployFeedList = ({
  appId,
  emptyText,
  environmentId,
}: {
  appId: string;
  /** Shown once the feed has loaded with no rows. */
  emptyText: string;
  environmentId: string;
}) => {
  const feed = liveFeed(
    feedKeys.deploys(appId, environmentId),
    deploysUrl(appId, environmentId),
    decodeDeploys,
    {
      initial: () =>
        api<RunnerDeploy[]>("/api/apps/listDeploys", {
          appId,
          environmentId,
        }),
    }
  );

  const items = (): RunnerDeploy[] => feed.latest() ?? [];

  const loaded = (): boolean =>
    feed.latest() !== undefined || feed.status() === "open";

  const retrying = (): boolean => feed.status() === "retrying";

  const currentSha =
    environmentId === ""
      ? (appDetail(appId).data()?.app.lastDeploySha ?? null)
      : null;

  // One sha can be deployed many times (redeploys, rollbacks); only the
  // newest successful deploy of the live sha is the one serving traffic.
  // The feed is newest-first. In an environment's feed the newest successful
  // deploy is that environment's live one.
  const liveId = (): string | null => {
    if (environmentId !== "") {
      return items().find((d) => d.status === "success")?.id ?? null;
    }

    if (currentSha === null) {
      return null;
    }

    return (
      items().find((d) => d.sha === currentSha && d.status === "success")?.id ??
      null
    );
  };

  return (
    <div class="flex w-full flex-col gap-4">
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          Deploy stream disconnected — retrying…
        </p>
      ) : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        {!loaded() && items().length === 0 && !retrying() ? (
          <li class="px-4 pt-4 pb-4">
            <ListSkeleton rows={2} />
          </li>
        ) : null}
        {loaded() && items().length === 0 && !retrying() ? (
          <li class="text-base-content/70 px-4 pt-4 pb-4 text-sm">
            {emptyText}
          </li>
        ) : null}
        {items().map((d) => (
          <DeployRow
            key={d.id}
            appId={appId}
            currentSha={currentSha}
            d={d}
            environmentId={environmentId}
            live={d.id === liveId()}
          />
        ))}
      </ul>
    </div>
  );
};

/** The Deployments tab: Production's live feed first, then one group per
 * environment (header + its own scoped feed), and **Create environment** in
 * the header. A `?env=<id>` query deep-links a group — it starts expanded. */
export const DeployList = ({
  appId,
  myRole,
  subdomain,
}: {
  appId: string;
  myRole: AppRole | undefined;
  subdomain: string;
}) => {
  const res = environments(appId);
  const app = appDetail(appId).data()?.app;
  const envs = res.data() ?? [];
  const open = atom(false);
  const deep = searchParam("env", { default: "" });
  const canPush = myRole === "push" || myRole === "admin";

  return (
    <div class="flex w-full flex-col gap-4">
      <div class="flex items-center justify-between gap-2">
        <h2 class="m-0 text-lg font-semibold">Deployments</h2>
        {canPush ? (
          <button
            type="button"
            class="btn btn-sm btn-neutral"
            onclick={() => {
              open.set(true);
            }}
          >
            <Plus />
            Create environment
          </button>
        ) : null}
      </div>
      <div class="flex w-full flex-col gap-2">
        <div class="bg-base-100 dark:bg-base-200 border-base-300 rounded-box flex w-full flex-wrap items-center gap-x-3 gap-y-2 border px-4 py-3 shadow-md">
          <span class="text-lg font-semibold">Production</span>
          {app ? (
            <DeployGroupMeta
              appId={appId}
              host={appHost(subdomain)}
              sha={app.lastDeploySha}
              status={app.status}
              url={appUrl(subdomain)}
            />
          ) : null}
        </div>
        <DeployFeedList
          appId={appId}
          emptyText="No deployments yet. Push to main to trigger one."
          environmentId=""
        />
      </div>
      <LoadError error={res.error()} />
      {envs.map((env) => (
        <EnvironmentGroup
          key={env.id}
          appId={appId}
          defaultOpen={deep() === env.id}
          env={env}
          myRole={myRole}
          subdomain={subdomain}
        >
          <DeployFeedList
            appId={appId}
            emptyText="No deployments yet for this environment."
            environmentId={env.id}
          />
        </EnvironmentGroup>
      ))}
      {envs.length === 0 && res.data() !== undefined ? (
        <p class="m-0 text-sm opacity-70">
          No environments yet — create one from a branch above, or deploy a
          preview from Code mode.
        </p>
      ) : null}
      <CreateEnvironmentDialog
        appId={appId}
        onCreated={(env) => {
          deep.set(env.id);
        }}
        open={open}
      />
    </div>
  );
};
