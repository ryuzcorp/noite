//! Deploy history: header dropdown + SSE list.
import { defineApp } from "@ilha/model";
import type { UpdateResult } from "@ilha/model";
import { Link } from "@ilha/void";
import { atom } from "ilha";

import { api } from "../api";
import { appHost, appUrl } from "../apps/identity";
import { formatDateTime } from "../dates";
import {
  decodeDeploys,
  deploysUrl,
  feedKeys,
  feedLoaded,
  feedLoading,
  feedProblem,
  feedRetrying,
  feedValue,
  liveFeed,
} from "../feeds";
import { islandProps } from "../island";
import { resourceValue, resourceError } from "../resource";
import { appDetail, deployLog, environments } from "../resources";
import type { AppRole } from "../roles";
import type { RunnerDeploy, RunnerEnvironment } from "../runner";
import { searchParam } from "../search-param";
import { confirmDialog } from "../ui/confirm";
import { CopyButton } from "../ui/copy-button";
import { ChevronDown, ChevronUp, CloudUpload, Plus } from "../ui/icons";
import { LoadError } from "../ui/load-error";
import { ListSkeleton } from "../ui/skeletons";
import { capabilities } from "./capabilities";
import {
  DropdownActionTypes,
  DropdownMsg,
  LookupTypes,
  RowActionTypes,
  RowMsg,
  rollbackTarget,
  rowOpen,
  updateDropdown,
  updateRow,
} from "./deploy.machine";
import type {
  DropdownMessage,
  DropdownModel,
  RowMessage,
  RowModel,
} from "./deploy.machine";
import {
  CreateEnvironmentDialog,
  DeployGroupMeta,
  EnvironmentGroup,
} from "./environments";
import {
  deployBadgeTone,
  deployIntentLabel,
  deployStatusFacts,
  isServing,
} from "./lifecycle";
import { RuntimeLogs } from "./logs";

/** The status badge for one deploy row, from the shared deploy facts: the
 * label is the reader's word for the state (`Stopped` for `cancelled`,
 * `Timed out` for `stalled`), while the wire status stays the runner's. */
export const deployBadge = (status: string) => (
  <span class={`badge badge-sm ${deployBadgeTone(status)}`}>
    {deployStatusFacts(status).label}
  </span>
);

const DropdownProps = islandProps<{
  appId: string;
  canPush: boolean;
  gitRemote: string;
  lastDeploySha: string | null;
  username: string;
}>("DeployDropdown");

/** Deploy (git remote) card dropdown. Lives in the page header next to
 * Code so it works on every tab; the rollback-target lookup and both
 * destructive actions are one machine (`deploy.machine.ts`): a failed lookup
 * is a failure with a retry, never "no target", and a second click is
 * refused. */
const DropdownApp = defineApp({
  init: (): UpdateResult<DropdownModel, DropdownMessage> => ({
    model: {
      action: DropdownActionTypes.Idle(),
      appId: DropdownProps.read().appId,
      liveSha: null,
      lookup: LookupTypes.Idle(),
    } satisfies DropdownModel,
  }),
  update: updateDropdown,
  view: (model, dispatch) => {
    const props = DropdownProps.read();

    const reload = (): void => {
      dispatch(DropdownMsg.TargetsOpened({ liveSha: props.lastDeploySha }));
    };

    let target = "";

    if (model.lookup._tag === "Found") {
      // Derived at render: the live sha is an input that lands after the
      // lookup (a page load opens the menu on the previous snapshot), so a
      // lookup must never freeze the target it was asked with.
      target = rollbackTarget(model.lookup.candidates, props.lastDeploySha);
    }

    const busy =
      model.action._tag === "Redeploying" ||
      model.action._tag === "RollingBack";

    return (
      // `key` pins this node in the header's action row: the row gains a
      // Stop/Start or Retry import control when the app's status lands, and a
      // positional morph would otherwise replace this subtree — closing an open
      // menu and dropping its state. The key makes ilha move it instead.
      <div key="deploy" class="dropdown dropdown-end">
        <div
          tabindex={0}
          role="button"
          class="btn btn-sm btn-neutral"
          onfocus={reload}
        >
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
                {props.gitRemote}
              </code>
              <CopyButton
                class="btn btn-sm shrink-0"
                iconOnly
                label="Copy git remote"
                value={props.gitRemote}
              />
            </div>
            <p class="m-0 text-sm opacity-80">
              Stock Git over HTTP — push <code>main</code> to deploy. Auth:{" "}
              <code>username={props.username}</code>, password = API key from{" "}
              <Link href="/account" class="link">
                Account
              </Link>
              .
            </p>
            {props.canPush ? null : (
              <p class="m-0 text-sm opacity-70">
                Need <code>push</code> or <code>admin</code> to push;{" "}
                <code>view</code> can fetch.
              </p>
            )}
            {props.canPush && props.lastDeploySha ? (
              <div class="flex flex-col gap-2">
                {model.action._tag === "Failed" &&
                model.action.kind === "redeploy" ? (
                  <p class="text-error m-0 text-sm">{model.action.error}</p>
                ) : null}
                <button
                  type="button"
                  class="btn btn-sm btn-neutral w-full"
                  disabled={busy}
                  title="Re-run the pipeline at the current commit with the latest env vars and flags"
                  onclick={() => {
                    const sha = props.lastDeploySha;

                    if (!sha) {
                      return;
                    }

                    dispatch(DropdownMsg.RedeployRequested({ sha }));
                  }}
                >
                  {model.action._tag === "Redeploying"
                    ? "Redeploying…"
                    : `Redeploy ${(props.lastDeploySha ?? "").slice(0, 12)}`}
                </button>
                <p class="m-0 text-xs opacity-70">
                  Picks up the latest env vars and flags. Progress shows in
                  Deployments.
                </p>
              </div>
            ) : null}
            {props.canPush && target ? (
              <div class="flex flex-col gap-2">
                {model.action._tag === "Failed" &&
                model.action.kind === "rollback" ? (
                  <p class="text-error m-0 text-sm">{model.action.error}</p>
                ) : null}
                <button
                  type="button"
                  class="btn btn-sm btn-ghost w-full"
                  disabled={busy}
                  title="Re-run the pipeline at an earlier release, without touching the checkout"
                  onclick={async () => {
                    const sha = target;

                    if (!sha) {
                      return;
                    }

                    const ok = await confirmDialog({
                      confirmLabel: "Roll back",
                      title: `Roll back to ${sha.slice(0, 12)}?`,
                    });

                    if (ok !== "confirm") {
                      return;
                    }

                    dispatch(DropdownMsg.RollbackRequested({ sha }));
                  }}
                >
                  {model.action._tag === "RollingBack"
                    ? "Rolling back…"
                    : `Roll back to ${target.slice(0, 12)}`}
                </button>
                <p class="m-0 text-xs opacity-70">
                  Restores the previous release; the checkout stays where it is.
                  Progress shows in Deployments.
                </p>
              </div>
            ) : null}
            {model.lookup._tag === "Failed" ? (
              <div class="flex flex-col gap-1">
                <p class="text-error m-0 text-xs">{model.lookup.error}</p>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost self-start"
                  disabled={busy}
                  onclick={reload}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {props.canPush && model.lookup._tag === "None" ? (
              <p class="m-0 text-xs opacity-60">
                No earlier successful deploy to roll back to yet.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  },
});

const DeployDropdownIsland = DropdownProps.wrap(DropdownApp);

export const DeployDropdown = ({ appId }: { appId: string }) => {
  const info = resourceValue(appDetail(appId).state());

  if (!info) {
    return null;
  }

  return (
    <DeployDropdownIsland
      appId={appId}
      canPush={capabilities(info.myRole).push}
      gitRemote={info.gitRemote}
      lastDeploySha={info.app.lastDeploySha}
      username={info.username}
    />
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
  const log = resourceValue(res.state())?.log;

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

const RowProps = islandProps<{
  appId: string;
  canPush: boolean;
  currentSha: string | null;
  d: RunnerDeploy;
  environmentId: string;
  live: boolean;
}>("DeployRow");

/** One deploy row. Expansion, the log tab, Stop and Roll back are one
 * machine: Stop is refused while a call is in flight, and a 409 ("already
 * closed") reads as information instead of a permanent red error. */
const RowApp = defineApp({
  init: (): UpdateResult<RowModel, RowMessage> => ({
    model: {
      action: RowActionTypes.Idle(),
      expanded: null,
      tab: "deploy",
    } satisfies RowModel,
  }),
  update: updateRow,
  view: (model, dispatch) => {
    const props = RowProps.read();
    const { d } = props;
    const facts = deployStatusFacts(d.status);
    const intent = deployIntentLabel(d.intent, d.sha);
    const open = rowOpen(model, props.live);

    const busy =
      model.action._tag === "Stopping" || model.action._tag === "RollingBack";

    // Roll back re-runs *this row's* target at that sha: production rows
    // rebuild production, a preview row rebuilds that environment (the runner
    // proves the sha was successful there), so a preview sha can never land in
    // production.
    const canRollBack =
      facts.succeeded && !!d.sha && d.sha !== props.currentSha;

    return (
      <>
        <li class="list-row">
          <div>{deployBadge(d.status)}</div>
          <div>
            <div class="font-mono text-sm">
              {d.sha ? (
                <Link
                  class="link link-hover"
                  href={`/apps/${props.appId}/source/commit/${d.sha}`}
                  title={d.sha}
                >
                  {d.sha.slice(0, 12)}
                </Link>
              ) : (
                "—"
              )}
            </div>
            <div class="text-base-content/70 text-xs">
              {intent === null ? null : <span class="mr-2">{intent}</span>}
              {formatDateTime(d.createdAt)}
            </div>
          </div>
          {model.action._tag === "Failed" ? (
            <p class="text-error m-0 text-xs">{model.action.error}</p>
          ) : null}
          {model.action._tag === "AlreadyClosed" ? (
            <p class="m-0 text-xs opacity-70">This deploy already finished.</p>
          ) : null}
          {props.canPush && facts.inFlight ? (
            <button
              type="button"
              class="btn btn-sm btn-ghost text-error shrink-0"
              disabled={busy}
              onclick={async () => {
                const ok = await confirmDialog({
                  confirmLabel: "Stop deploy",
                  message:
                    "The step running now is killed and the deploy is closed as stopped. The release serving traffic stays as it is.",
                  title: "Stop this deploy?",
                });

                if (ok !== "confirm") {
                  return;
                }

                dispatch(
                  RowMsg.StopRequested({
                    appId: props.appId,
                    deployId: d.id,
                  })
                );
              }}
            >
              {model.action._tag === "Stopping" ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          {canRollBack ? (
            <button
              type="button"
              class="btn btn-sm btn-ghost shrink-0"
              disabled={busy}
              onclick={async () => {
                const { sha } = d;

                if (!sha) {
                  return;
                }

                const ok = await confirmDialog({
                  confirmLabel: "Roll back",
                  title: `Roll back to ${sha.slice(0, 12)}?`,
                });

                if (ok !== "confirm") {
                  return;
                }

                dispatch(
                  RowMsg.RollbackRequested({
                    appId: props.appId,
                    deployId: d.id,
                    environmentId: props.environmentId,
                    sha,
                  })
                );
              }}
            >
              {model.action._tag === "RollingBack"
                ? "Rolling back…"
                : "Roll back"}
            </button>
          ) : null}
          <button
            type="button"
            class="btn btn-sm btn-ghost shrink-0"
            aria-expanded={open}
            onclick={() => {
              dispatch(RowMsg.LogsToggled({ live: props.live }));
            }}
          >
            <span class="inline-flex items-center gap-1">
              {open ? "Hide logs" : "View logs"}
              {open ? <ChevronUp /> : <ChevronDown />}
            </span>
          </button>
        </li>
        {open ? (
          <li class="flex flex-col gap-2 px-4 pb-4">
            <div role="tablist" class="tabs tabs-border w-fit">
              <button
                type="button"
                role="tab"
                aria-selected={model.tab === "deploy"}
                class={`tab ${model.tab === "deploy" ? "tab-active" : ""}`}
                onclick={() => {
                  dispatch(RowMsg.TabPicked({ tab: "deploy" }));
                }}
              >
                Deployment logs
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={model.tab === "build"}
                class={`tab ${model.tab === "build" ? "tab-active" : ""}`}
                onclick={() => {
                  dispatch(RowMsg.TabPicked({ tab: "build" }));
                }}
              >
                Build logs
              </button>
            </div>
            <BuildLogPane
              appId={props.appId}
              d={d}
              environmentId={props.environmentId}
              tab={model.tab}
            />
          </li>
        ) : null}
      </>
    );
  },
});

const DeployRowIsland = RowProps.wrap(RowApp);

/** One environment's deploy history over SSE: skeleton until the first frame,
 * then the event stream pushes updates — no polling, and rows never remount
 * underneath an open log. `environmentId` is `""` for production. */
const DeployFeedList = ({
  appId,
  canPush,
  emptyText,
  environmentId,
}: {
  appId: string;
  canPush: boolean;
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

  const items = (): RunnerDeploy[] => feedValue(feed.state()) ?? [];

  const loaded = (): boolean => feedLoaded(feed.state());

  const retrying = (): boolean => feedRetrying(feed.state());

  const problem = (): string | null => feedProblem(feed.state());

  const app = resourceValue(appDetail(appId).state())?.app;

  const env: RunnerEnvironment | undefined =
    environmentId === ""
      ? undefined
      : (resourceValue(environments(appId).state()) ?? []).find(
          (one) => one.id === environmentId
        );

  // Production's live release is the app's own sha; an environment's is its
  // newest successful row. A scope the runner has stopped serves nothing.
  const currentSha = environmentId === "" ? (app?.lastDeploySha ?? null) : null;

  const liveId = (): string | null => {
    if (environmentId === "") {
      if (!app || !isServing(app) || currentSha === null) {
        return null;
      }

      return (
        items().find(
          (d) => d.sha === currentSha && deployStatusFacts(d.status).succeeded
        )?.id ?? null
      );
    }

    if (!env || !isServing(env)) {
      return null;
    }

    return (
      items().find((d) => deployStatusFacts(d.status).succeeded)?.id ?? null
    );
  };

  return (
    <div class="flex w-full flex-col gap-4">
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          Deploy stream disconnected — retrying…
        </p>
      ) : null}
      {problem() ? <p class="text-error m-0 text-sm">{problem()}</p> : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        {feedLoading(feed.state()) ? (
          <li class="px-4 pt-4 pb-4">
            <ListSkeleton rows={2} />
          </li>
        ) : null}
        {loaded() && items().length === 0 && !retrying() && !problem() ? (
          <li class="text-base-content/70 px-4 pt-4 pb-4 text-sm">
            {emptyText}
          </li>
        ) : null}
        {items().map((d) => (
          <DeployRowIsland
            key={d.id}
            appId={appId}
            canPush={canPush}
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
  const app = resourceValue(appDetail(appId).state())?.app;
  const envs = resourceValue(res.state()) ?? [];
  const open = atom(false);
  const deep = searchParam("env", { default: "" });
  const canPush = capabilities(myRole).push;

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
              desiredState={app.desiredState}
              host={appHost(subdomain)}
              sha={app.lastDeploySha}
              status={app.status}
              url={appUrl(subdomain)}
            />
          ) : null}
        </div>
        <DeployFeedList
          appId={appId}
          canPush={canPush}
          emptyText="No deployments yet. Push to main to trigger one."
          environmentId=""
        />
      </div>
      <LoadError error={resourceError(res.state())} />
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
            canPush={canPush}
            emptyText="No deployments yet for this environment."
            environmentId={env.id}
          />
        </EnvironmentGroup>
      ))}
      {envs.length === 0 && resourceValue(res.state()) !== undefined ? (
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
