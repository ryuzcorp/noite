//! Code mode's Preview panel: frames what is deployed for the browsed branch
//! — the viewer's own workspace preview while they have uncommitted changes
//! (or right after they deployed one), else the branch's own environment (a
//! branch environment redeploys on every push, so the frame follows it), else
//! production for the default branch. One bar on top: the target's status,
//! name and address, Deploy preview, reload, an editable address, copy, open
//! in a new tab, the target's deploys and close. The latest deploy's build log
//! sits under the frame.
//!
//! Deploy preview snapshots the uncommitted changes as one commit on the
//! viewer's hidden preview ref and deploys that (viewer, branch) environment —
//! the changes stay uncommitted and the frame moves to what was just deployed.
//! A preview whose snapshot is older than the latest edit says so, with the
//! deploy right there.
//!
//! A members-only environment passes the access gate inside the frame (the
//! environment is same-site with the control UI, so the control's cookie and
//! the gate's redirect both work there — `/api/env-auth` answers the cases the
//! gate cannot, as its own small pages).

import { Link } from "@ilha/void";
import { atom, watch } from "ilha";
import type { AtomHandle, View } from "ilha";

import { deployBadge } from "../app-detail/deploys";
import { appUrl, environmentUrl, presenceTone } from "../apps/identity";
import { decodeDeploys, deploysUrl, feedKeys, liveFeed } from "../feeds";
import { forgeRefs } from "../forge/data";
import {
  appDetail,
  deployLog,
  environments,
  invalidateEnvironments,
  session,
} from "../resources";
import type { RunnerApp, RunnerDeploy, RunnerEnvironment } from "../runner";
import { CopyButton } from "../ui/copy-button";
import { ArrowUpRight, List, Refresh } from "../ui/icons";
import { LoadError } from "../ui/load-error";
import { PanelClose } from "../ui/side-panel";
import { ListSkeleton } from "../ui/skeletons";
import type { ReadOnlyRef, SourceBrowserState } from "./drafts";
import {
  changesFingerprint,
  expiryLabel,
  workspacePreviewRef,
} from "./preview-env";

/** How long the frame has to report itself loaded before the panel says it is
 * not answering: a host that black-holes the connection, or a version the
 * browser refuses, leaves the pane blank with no error at all. */
const LOAD_TIMEOUT_MS = 20_000;

/** A finished deploy's build log (the stream omits finished rows' logs): the
 * same on-demand, cached-forever read the Deployments tab uses. A read that
 * failed is said so and can be retried — the message that stood here forever
 * was a promise the panel could not keep. */
const FinishedLog = ({
  appId,
  deployId,
}: {
  appId: string;
  deployId: string;
}) => {
  const res = deployLog(appId, deployId);

  if (res.error()) {
    return (
      <div class="flex flex-col items-start gap-2 px-3 pb-2">
        <LoadError error={res.error()} label="Failed to load the build log" />
        <button
          type="button"
          class="btn btn-xs"
          onclick={() => {
            void res.refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <pre class="max-h-40 overflow-auto px-3 pb-2 font-mono text-xs whitespace-pre-wrap">
      {res.data()?.log ?? "(loading build log…)"}
    </pre>
  );
};

/** The build log under the frame: the stream carries a running deploy's log,
 * a finished one is read once (see `FinishedLog`). */
const DeployLog = ({
  appId,
  row,
}: {
  appId: string;
  row: RunnerDeploy | undefined;
}) => {
  if (row === undefined) {
    return (
      <p class="m-0 px-3 pb-2 text-xs opacity-70">Waiting for the deploy…</p>
    );
  }

  if (row.log !== "") {
    return (
      <pre class="max-h-40 overflow-auto px-3 pb-2 font-mono text-xs whitespace-pre-wrap">
        {row.log}
      </pre>
    );
  }

  // A running deploy's log is still in the stream (the row carries it as it
  // arrives); a finished row's is read once.
  const finished =
    row.status !== "building" &&
    row.status !== "deploying" &&
    row.status !== "queued";

  return finished ? (
    <FinishedLog appId={appId} deployId={row.id} />
  ) : (
    <p class="m-0 px-3 pb-2 text-xs opacity-70">Building…</p>
  );
};

/** Whether a deploy is still going: the states between the queue and a
 * result. */
const deployRunning = (status: string): boolean => {
  if (status === "queued" || status === "building" || status === "deploying") {
    return true;
  }

  return false;
};

/** What the panel frames: production, a branch environment, or the viewer's
 * own workspace preview. */
interface FrameTarget {
  /** The deploy feed it follows: "" for production, else the environment id. */
  environmentId: string;
  /** `expires in 7 days` — only a workspace preview expires. */
  expiry: string | null;
  kind: "branch" | "production" | "workspace";
  label: string;
  status: string;
  url: string;
}

/** What the bar names the target, and what its tooltip says. */
const targetTitle = (target: FrameTarget): string => {
  if (target.kind === "production") {
    return `production · ${target.status}`;
  }

  if (target.kind === "workspace") {
    return `your preview of this branch · ${target.status}`;
  }

  return `the branch's environment · ${target.status}`;
};

/** One environment as the panel frames it. */
const environmentTarget = (
  app: RunnerApp,
  environment: RunnerEnvironment
): FrameTarget => ({
  environmentId: environment.id,
  expiry: environment.kind === "workspace" ? expiryLabel(environment) : null,
  kind: environment.kind === "workspace" ? "workspace" : "branch",
  label: environment.label,
  status: environment.status,
  url: environmentUrl(app.subdomain, environment.label),
});

/** Production, once it has deployed. `main` is the app itself and never an
 * environment. */
const productionTarget = (app: RunnerApp): FrameTarget | null =>
  app.lastDeploySha
    ? {
        environmentId: "",
        expiry: null,
        kind: "production",
        label: "production",
        status: app.status,
        url: appUrl(app.subdomain),
      }
    : null;

/** The two environments one branch can have: the viewer's own workspace
 * preview (`refs/previews/<user>/<branch>`, their uncommitted work) and the
 * branch's own (`refs/heads/<branch>`, which redeploys on every push). */
const candidatesFor = (
  rows: readonly RunnerEnvironment[],
  viewerId: string,
  branch: string
) => {
  const previewRef = workspacePreviewRef(viewerId, branch);

  return {
    branchEnv: rows.find(
      (row) => row.kind === "branch" && row.gitRef === `refs/heads/${branch}`
    ),
    workspace: rows.find(
      (row) => row.kind === "workspace" && row.gitRef === previewRef
    ),
  };
};

/** What the panel frames for `branch`: the viewer's own preview while it is
 * what their edits are in (`scope` overrides the automatic choice, and
 * production stands in for the default branch when nothing else does). Null
 * when nothing is deployed for the branch at all. */
const pickTarget = ({
  app,
  branch,
  branchEnv,
  defaultBranch,
  scope,
  workspace,
  workspaceFresh,
}: {
  app: RunnerApp;
  branch: string;
  branchEnv: RunnerEnvironment | undefined;
  defaultBranch: string;
  scope: "branch" | "workspace" | null;
  workspace: RunnerEnvironment | undefined;
  workspaceFresh: boolean;
}): FrameTarget | null => {
  let branchTarget: FrameTarget | null = null;

  if (branchEnv !== undefined) {
    branchTarget = environmentTarget(app, branchEnv);
  } else if (branch === defaultBranch) {
    branchTarget = productionTarget(app);
  }

  const workspaceTarget =
    workspace === undefined ? null : environmentTarget(app, workspace);

  if (scope === "workspace") {
    return workspaceTarget ?? branchTarget;
  }

  if (scope === "branch") {
    return branchTarget ?? workspaceTarget;
  }

  const preferred = workspaceFresh ? workspaceTarget : null;

  return preferred ?? branchTarget ?? workspaceTarget;
};

const ICON_BUTTON = "btn btn-ghost btn-xs btn-square";
const BAR = "border-base-300 flex flex-col border-b py-1 pr-1.5 pl-2";

/** One row of the bar. The bar is two of them — the target and the close
 * button, then the actions and the address — so a narrow panel wraps where it
 * is meant to: a wrapped bar must never leave the × alone on a row of its own
 * (every other side panel keeps it at the top-right corner). */
const BAR_ROW = "flex min-h-7 items-center gap-1";

/** Why Deploy preview is off for a read-only checkout. */
const READ_ONLY_DEPLOY: Record<Exclude<ReadOnlyRef, "">, string> = {
  commit: "Read-only — a commit checkout can't be deployed.",
  role: "Read-only — you need push access to deploy a preview.",
  tag: "Read-only — a tag checkout can't be deployed.",
};

/** A failed deploy as the user reads it: the workspace's own read-only refusal
 * gets copy that names the reason, anything else keeps its words. */
const deployErrorCopy = (raw: string, readOnly: ReadOnlyRef): string =>
  readOnly !== "" && raw.toLowerCase().includes("read-only")
    ? READ_ONLY_DEPLOY[readOnly]
    : raw;

/** Deploy preview / Redeploy in its own button, with the reason it is off in
 * the wrapper's tooltip: a disabled button receives no hover of its own. */
const DeployButton = ({
  hint,
  label,
  off,
  onClick,
}: {
  hint: string;
  label: string;
  off: string | null;
  onClick: () => void;
}) => (
  <span class="inline-flex shrink-0" title={off ?? hint}>
    <button
      type="button"
      class="btn btn-xs btn-neutral"
      disabled={off !== null}
      onclick={onClick}
    >
      {label}
    </button>
  </span>
);

/** The target's status dot: the name beside it says which environment this is,
 * so the dot's own label and title are its status. */
const StatusDot = ({ label, status }: { label: string; status: string }) => (
  <span
    class="flex size-5 shrink-0 items-center justify-center"
    role="img"
    aria-label={`${label}: ${status}`}
    title={status}
  >
    <span class={`status ${presenceTone(status)}`} />
  </span>
);

/** Branch or the viewer's own preview, when one branch has both: the automatic
 * choice follows their edits, and picking one pins the frame to it. */
const ScopeSwitch = ({
  onPick,
  scope,
}: {
  onPick: (next: "branch" | "workspace") => void;
  scope: "branch" | "workspace";
}) => (
  <div
    class="join shrink-0"
    role="group"
    aria-label="Which environment to preview"
  >
    {(
      [
        ["branch", "Branch"],
        ["workspace", "My preview"],
      ] as const
    ).map(([value, label]) => (
      <button
        key={value}
        type="button"
        class={`join-item btn btn-xs ${scope === value ? "btn-neutral" : "btn-ghost"}`}
        aria-pressed={scope === value ? "true" : "false"}
        onclick={() => {
          onPick(value);
        }}
      >
        {label}
      </button>
    ))}
  </div>
);

/** The address `typed` points at: a full http(s) URL as typed, anything else
 * (a path, `?query`, `#hash`) against the frame's current address. Null when
 * it is neither. */
const resolveAddress = (typed: string, current: string): string | null => {
  try {
    const url = new URL(typed.trim(), current);

    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** What the framed target still needs from the panel: which of the viewer's
 * uncommitted changes it does not hold, why Deploy preview is off before the
 * target's own deploy is considered, and who to ask for one. */
interface TargetProps {
  appId: string;
  /** Deploy preview, or Redeploy once this branch already has the viewer's. */
  deployLabel: string;
  /** Why Deploy preview is off (null = it is on). */
  deployOff: string | null;
  /** The uncommitted changes the target does not hold (0 = it holds them all,
   * or there are none). */
  missing: number;
  onClose: () => void;
  onDeploy: () => void;
  scopeSwitch: View | null;
  target: FrameTarget;
}

/** What a target that is not serving says instead of a blank frame; null when
 * it is serving normally. */
const statusNote = (status: string): string | null => {
  if (status === "failed" || status === "error") {
    return "This preview failed. The build log below says why, and a new deploy retries it.";
  }

  if (status === "stopped") {
    return "This preview is stopped, so nothing is serving here. Deploy again to bring it back.";
  }

  return null;
};

/** The bar and frame for one target, keyed by it: a branch switch to another
 * target starts again at that target's address. The frame follows the
 * target's deploys: once a new deploy *succeeds* — a push to the branch builds
 * and goes live — it reloads at the current address, as the reload button
 * does. A deploy still building leaves the frame alone, since the previous
 * build is what is serving until then. */
const TargetPreview = ({
  appId,
  deployLabel,
  deployOff,
  missing,
  onClose,
  onDeploy,
  scopeSwitch,
  target,
}: TargetProps) => {
  const feed = liveFeed(
    feedKeys.deploys(appId, target.environmentId),
    deploysUrl(appId, target.environmentId),
    decodeDeploys
  );

  const rows = feed.latest() ?? [];
  const [row] = rows;
  // What is serving: the newest deploy that succeeded (the feed is newest
  // first). Its id keys the frame, so the frame reloads when it goes live.
  const live = rows.find((deploy) => deploy.status === "success");
  const going = row !== undefined && deployRunning(row.status);
  const off = deployOff ?? (going ? "A deploy is already running." : null);
  // What a target that is not serving says in place of the frame (null when it
  // is serving).
  const note = statusNote(target.status);
  // The frame's address, and what the address field holds (it differs while
  // the viewer types; Enter navigates, Escape puts it back).
  const address = atom(target.url);
  const typed = atom(target.url);
  const invalid = atom(false);
  // Bumped by the reload button (and by Enter on the address already
  // loaded): part of the frame's reload token, see the frame's `ref`.
  const loads = atom(0);
  // The reload token the frame last loaded for: a new successful deploy or a
  // reload bump changes it, and the frame's `ref` then loads it again.
  const loaded = atom.lazy(() => ({ token: "" }))();
  // The build log's disclosure: open while the deploy is still going, closed
  // once it succeeded (the frame gets the height). Only a *change* of status
  // decides it, so a repaint never closes a log the viewer opened.
  const logOpen = atom(false);
  const seen = atom.lazy(() => ({ status: "" }))();
  const focusing = atom.lazy(() => ({ armed: false }))();
  // The frame's own liveness: a load that never arrives says so and can be
  // retried, instead of leaving a blank pane that looks like an empty app.
  const timedOut = atom(false);
  const loadTimer = atom.lazy(() => ({ id: 0 }))();
  watch(feed.latest, (next) => {
    const status = (next ?? [])[0]?.status ?? "";

    if (status !== seen.status) {
      // A deploy that just finished moved the environment's own status
      // (building → running/failed) too: read it again so the dot follows.
      if (deployRunning(seen.status) && !deployRunning(status)) {
        invalidateEnvironments(appId);
      }

      seen.status = status;
      logOpen.set(status !== "" && status !== "success");
    }
  });

  /** Give the frame `LOAD_TIMEOUT_MS` to load again: what a reload and a
   * fresh target start with. */
  const armFrame = () => {
    window.clearTimeout(loadTimer.id);
    timedOut.set(false);
    loadTimer.id = window.setTimeout(() => {
      timedOut.set(true);
    }, LOAD_TIMEOUT_MS);
  };

  watch.once(({ onCleanup }) => {
    if (typeof document === "undefined") {
      // SSR: no frame to time; the client's own mount arms it.
      return;
    }

    armFrame();
    onCleanup(() => {
      window.clearTimeout(loadTimer.id);
    });
  });

  const reload = () => {
    loads.set(loads() + 1);
    armFrame();
  };

  // Read here, in the render, so a reload bump repaints (the frame's `ref`
  // runs on each paint, but reads made inside it are not tracked).
  const reloadToken = `${live?.id ?? ""}:${loads()}`;

  const deploysHref =
    target.environmentId === ""
      ? `/apps/${appId}?t=deployments`
      : `/apps/${appId}?t=deployments&env=${target.environmentId}`;

  return (
    <>
      <div class={BAR}>
        <div class={BAR_ROW}>
          <StatusDot label={target.label} status={target.status} />
          <span
            class="max-w-32 min-w-0 shrink truncate font-mono text-xs"
            title={targetTitle(target)}
          >
            {target.label}
          </span>
          {target.expiry === null ? null : (
            <span class="hidden shrink-0 text-xs opacity-60 sm:inline">
              {target.expiry}
            </span>
          )}
          {scopeSwitch}
          <span class="flex-1" />
          <PanelClose onClose={onClose} />
        </div>
        <div class={`${BAR_ROW} flex-wrap`}>
          <DeployButton
            hint="Snapshots your uncommitted changes and deploys them to your own preview environment."
            label={deployLabel}
            off={off}
            onClick={onDeploy}
          />
          <form
            class="min-w-32 flex-1"
            onsubmit={(event) => {
              event.preventDefault();
              const raw = typed().trim();

              // An empty field is not a navigation: it puts the current address
              // back (and never reloads, which is where an empty URL would have
              // landed).
              if (raw === "") {
                typed.set(address());
                invalid.set(false);

                return;
              }

              const next = resolveAddress(raw, address());

              if (next === null) {
                invalid.set(true);

                return;
              }

              if (next === address()) {
                // The address already loaded: Enter is a reload.
                reload();

                return;
              }

              address.set(next);
              typed.set(next);
            }}
          >
            <input
              class={`input input-xs w-full font-mono ${invalid() ? "input-error" : ""}`}
              aria-label="Address"
              spellcheck={false}
              value={typed()}
              oninput={(event) => {
                typed.set(event.currentTarget.value);
                invalid.set(false);
              }}
              onkeydown={(event) => {
                if (event.key === "Escape") {
                  typed.set(address());
                  invalid.set(false);
                  event.currentTarget.blur();
                }
              }}
              onfocus={(event) => {
                focusing.armed = true;
                event.currentTarget.select();
              }}
              onmouseup={(event) => {
                // The click that focused the field selects all of it, like a
                // browser's address bar: its mouseup would otherwise drop the
                // selection for a caret. Later clicks place the caret.
                if (focusing.armed) {
                  focusing.armed = false;
                  event.preventDefault();
                }
              }}
              onblur={() => {
                focusing.armed = false;
              }}
            />
          </form>
          <button
            type="button"
            class={ICON_BUTTON}
            aria-label="Reload"
            title="Reload"
            onclick={reload}
          >
            <Refresh class="h-3.5 w-3.5" />
          </button>
          <CopyButton
            class={ICON_BUTTON}
            iconClass="h-3.5 w-3.5"
            iconOnly
            label="Copy address"
            value={address()}
          />
          <a
            class={ICON_BUTTON}
            href={address()}
            target="_blank"
            rel="noopener"
            aria-label="Open in a new tab"
            title="Open in a new tab"
          >
            <ArrowUpRight class="h-3.5 w-3.5" />
          </a>
          <Link
            class={ICON_BUTTON}
            href={deploysHref}
            aria-label={`Deploys for ${target.label}`}
            title={`Deploys for ${target.label}`}
          >
            <List class="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
      {missing === 0 ? null : (
        <div
          class="bg-warning/15 border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-1.5"
          role="status"
        >
          <span class="min-w-0 text-xs">
            Your {missing} unsaved{" "}
            {missing === 1 ? "change isn't" : "changes aren't"} in this preview.
          </span>
          <DeployButton
            hint="Snapshots your uncommitted changes and deploys them to your own preview environment."
            label={deployLabel}
            off={off}
            onClick={onDeploy}
          />
        </div>
      )}
      {note === null ? null : (
        <p class="border-base-300 m-0 border-b px-3 py-2 text-xs" role="status">
          {note}
        </p>
      )}
      {note === null && timedOut() ? (
        <div
          class="border-base-300 flex flex-wrap items-center gap-2 border-b px-3 py-1.5"
          role="status"
        >
          <span class="min-w-0 text-xs">
            This preview has not answered yet. The address may be wrong, or the
            environment may still be starting.
          </span>
          <button type="button" class="btn btn-xs" onclick={reload}>
            Retry
          </button>
        </div>
      ) : null}
      {note === null ? (
        <iframe
          src={address()}
          title={`${target.label} preview`}
          class="bg-base-100 min-h-0 w-full flex-1 border-0"
          onload={() => {
            window.clearTimeout(loadTimer.id);
            timedOut.set(false);
          }}
          ref={(el) => {
            // ilha patches the frame in place (a changed `key` does not
            // replace it), and an unchanged `src` never reloads it. Setting
            // `src` always navigates, even to the same URL, so a new token —
            // a deploy that went live, or the reload button — reloads here.
            if (
              typeof HTMLIFrameElement !== "undefined" &&
              el instanceof HTMLIFrameElement &&
              loaded.token !== reloadToken
            ) {
              if (loaded.token !== "") {
                el.src = address();
              }

              loaded.token = reloadToken;
            }
          }}
        />
      ) : (
        <div class="bg-base-100/60 flex min-h-0 flex-1 items-center justify-center p-6">
          <div class="rounded-box border-base-300 bg-base-100 flex max-w-md flex-col gap-2 border p-4">
            <p class="m-0 text-sm">{note}</p>
            <a
              class="link text-xs"
              href={address()}
              target="_blank"
              rel="noopener"
            >
              Open {target.label} in a new tab
            </a>
          </div>
        </div>
      )}
      <details
        class="border-base-300 border-t"
        open={logOpen()}
        ontoggle={(event) => {
          logOpen.set(event.currentTarget.open);
        }}
      >
        <summary class="flex cursor-pointer items-center gap-2 px-3 py-1.5">
          <span class="text-xs opacity-70">Build log</span>
          {row ? (
            deployBadge(row.status)
          ) : (
            <span class="text-xs opacity-70">no deploys</span>
          )}
        </summary>
        {logOpen() ? <DeployLog appId={appId} row={row} /> : null}
      </details>
    </>
  );
};

/** Why Deploy preview is off, or null when it is on: a read-only checkout, an
 * empty workspace, or a snapshot already in flight. */
const deployOffReason = (
  current: SourceBrowserState,
  deploying: boolean
): string | null => {
  if (current.readOnly !== "") {
    return READ_ONLY_DEPLOY[current.readOnly];
  }

  if (current.files.length === 0) {
    return "There are no uncommitted changes to deploy.";
  }

  return deploying ? "Snapshotting your changes…" : null;
};

/** Whether the framed target holds every edit: a workspace preview is current
 * only while the changes it deployed are still the checkout's, so an edit
 * after the deploy means the frame is showing older work. */
const snapshotCurrent = (
  target: FrameTarget | null,
  snapshotted: string | null,
  fingerprint: string
): boolean =>
  target !== null && target.kind === "workspace" && snapshotted === fingerprint;

/** Which environment the switch is on, when a branch has both to switch
 * between; null when there is no switch to draw. */
const switchScope = (
  target: FrameTarget | null,
  branchEnv: RunnerEnvironment | undefined,
  workspace: RunnerEnvironment | undefined
): "branch" | "workspace" | null => {
  if (branchEnv === undefined || workspace === undefined) {
    return null;
  }

  return target?.kind === "workspace" ? "workspace" : "branch";
};

/** What the panel shows for one branch, decided in one place: what it frames
 * (null when nothing is deployed for the branch), why Deploy preview is off,
 * what its button reads, how many of the viewer's uncommitted changes the
 * target does not hold, and which environment the switch is on (null when
 * there is no switch to draw). */
interface PanelView {
  deployLabel: string;
  deployOff: string | null;
  missing: number;
  scope: "branch" | "workspace" | null;
  target: FrameTarget | null;
}

const panelView = ({
  app,
  branch,
  current,
  defaultBranch,
  deploying,
  rows,
  scope,
  viewer,
}: {
  app: RunnerApp;
  branch: string;
  current: SourceBrowserState;
  defaultBranch: string;
  deploying: boolean;
  rows: readonly RunnerEnvironment[];
  scope: "auto" | "branch" | "workspace";
  viewer: string;
}): PanelView => {
  const { branchEnv, workspace } = candidatesFor(rows, viewer, branch);
  // What the checkout holds right now, and what this browser last deployed for
  // this branch: the panel compares them (see `changesFingerprint`).
  const fingerprint = changesFingerprint(current.files);

  const snapshotted =
    current.previewed !== null && current.previewed.branch === branch
      ? current.previewed.fingerprint
      : null;

  const target = pickTarget({
    app,
    branch,
    branchEnv,
    defaultBranch,
    scope: scope === "auto" ? null : scope,
    workspace,
    workspaceFresh: current.files.length > 0 || snapshotted === fingerprint,
  });

  const fresh = snapshotCurrent(target, snapshotted, fingerprint);
  const deployedBefore = workspace !== undefined || snapshotted !== null;

  return {
    deployLabel: deployedBefore ? "Redeploy" : "Deploy preview",
    deployOff: deployOffReason(current, deploying),
    missing: current.files.length > 0 && !fresh ? current.files.length : 0,
    scope: switchScope(target, branchEnv, workspace),
    target,
  };
};

/** The environment rows the panel matches against: the read ones, plus what
 * Deploy preview just returned, until that read catches up. */
const withDeployed = (
  rows: readonly RunnerEnvironment[],
  mine: RunnerEnvironment | null
) =>
  mine !== null && !rows.some((row) => row.id === mine.id)
    ? [mine, ...rows]
    : rows;

/** What the last Deploy preview returned, while it is this branch's (a branch
 * switch makes it another branch's business). */
const justDeployedFor = (
  deployed: { branch: string; environment: RunnerEnvironment } | null,
  branch: string
): RunnerEnvironment | null =>
  deployed !== null && deployed.branch === branch ? deployed.environment : null;

/** A deploy that failed, above whatever the panel frames. Only a deploy this
 * panel asked for is reported: the state's push error slot is shared with the
 * Changes panel's push, and a push is not this panel's business. */
const DeployError = ({
  attempted,
  current,
}: {
  attempted: boolean;
  current: SourceBrowserState;
}) => {
  if (!attempted || current.pushError === "") {
    return null;
  }

  return (
    <p
      class="bg-error/15 text-error border-base-300 m-0 border-b px-3 py-1.5 text-xs"
      role="alert"
    >
      {deployErrorCopy(current.pushError, current.readOnly)}
    </p>
  );
};

/** The Preview panel body: the bar and the framed target, or — nothing
 * deployed for the branch — the bar and Deploy preview. */
export const PreviewPanel = ({
  appId,
  branch,
  onClose,
  onDeployPreview,
  state,
}: {
  appId: string;
  branch: string;
  onClose: () => void;
  /** Snapshot the workspace and deploy its preview environment (null when
   * there is nothing to snapshot, or it failed — the reason then rides the
   * reported state's `pushError`). */
  onDeployPreview: () => Promise<RunnerEnvironment | null>;
  state: AtomHandle<SourceBrowserState>;
}) => {
  const app = appDetail(appId).data()?.app;
  const current = state();
  const viewer = session().data()?.user.id ?? "";
  const envs = environments(appId);

  // The scope the viewer picked, and the branch they picked it on: a branch
  // switch goes back to the automatic choice. An atom rather than a field, so
  // the switch repaints the bar.
  const scope = atom<{
    branch: string;
    value: "auto" | "branch" | "workspace";
  }>({ branch, value: "auto" });

  // What Deploy preview returned, before the environments read catches up: the
  // frame moves to what was just deployed, not to what was known before it.
  const deployed = atom<{
    branch: string;
    environment: RunnerEnvironment;
  } | null>(null);

  const deploying = atom(false);
  // Whether this mount asked for a deploy at all: the state's push error slot
  // is shared with the Changes panel's push, and a push is not this panel's
  // business to report.
  const attempted = atom(false);

  const runDeploy = () => {
    if (deploying()) {
      return;
    }

    deploying.set(true);
    attempted.set(true);
    scope.set({ branch, value: "workspace" });
    void (async () => {
      try {
        const previewed = await onDeployPreview();

        if (previewed !== null) {
          deployed.set({ branch, environment: previewed });
          // The Deployments tab read its rows (and the app's own deploy
          // state) before this: read them again.
          invalidateEnvironments(appId);
        }
      } finally {
        deploying.set(false);
      }
    })();
  };

  if (!app) {
    return (
      <div class="p-3">
        <ListSkeleton rows={3} />
      </div>
    );
  }

  const defaultBranch = forgeRefs(appId).data()?.defaultBranch ?? "main";
  const mine = justDeployedFor(deployed(), branch);
  const all = withDeployed(envs.data() ?? [], mine);
  const picked = scope();

  const view = panelView({
    app,
    branch,
    current,
    defaultBranch,
    deploying: deploying(),
    rows: all,
    scope: picked.branch === branch ? picked.value : "auto",
    viewer,
  });

  if (view.target === null) {
    return (
      <div class="flex min-h-0 flex-1 flex-col">
        <div class={BAR}>
          <div class={BAR_ROW}>
            <span class="min-w-0 truncate px-1 font-mono text-xs">
              {branch}
            </span>
            <span class="flex-1" />
            <PanelClose onClose={onClose} />
          </div>
          <div class={BAR_ROW}>
            <DeployButton
              hint="Snapshots your uncommitted changes and deploys them to your own preview environment."
              label={view.deployLabel}
              off={view.deployOff}
              onClick={runDeploy}
            />
          </div>
        </div>
        <DeployError attempted={attempted()} current={current} />
        <p class="m-0 p-3 text-sm opacity-70">
          {branch === defaultBranch ? (
            "Production has not deployed yet. Push to main to deploy it, or deploy a preview of your changes."
          ) : (
            <>
              <span class="font-mono">{branch}</span> has no environment yet.
              Deploy a preview of your changes, or create the branch's
              environment on the{" "}
              <Link class="link" href={`/apps/${appId}?t=deployments`}>
                Deployments
              </Link>
              tab — it deploys every push to the branch.
            </>
          )}
        </p>
      </div>
    );
  }

  const { target } = view;

  const scopeSwitch =
    view.scope === null ? null : (
      <ScopeSwitch
        onPick={(next) => {
          scope.set({ branch, value: next });
        }}
        scope={view.scope}
      />
    );

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <DeployError attempted={attempted()} current={current} />
      <TargetPreview
        key={target.environmentId === "" ? "production" : target.environmentId}
        appId={appId}
        deployLabel={view.deployLabel}
        deployOff={view.deployOff}
        missing={view.missing}
        onClose={onClose}
        onDeploy={runDeploy}
        scopeSwitch={scopeSwitch}
        target={target}
      />
    </div>
  );
};
