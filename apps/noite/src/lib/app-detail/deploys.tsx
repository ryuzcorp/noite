//! Deploy history: header dropdown + SSE list.
import { atom, unsafe, watch } from "ilha";

import { get, rollback } from "../apps.server";
import { formatDateTime } from "../dates";
import type { RunnerDeploy } from "../runner";
import { ListSkeleton } from "../skeletons";
import { readSwrCache, writeSwrCache } from "../swr-cache";
import {
  CHECK_SVG,
  CHEVRON_DOWN_SVG,
  CHEVRON_UP_SVG,
  CLOUD_UPLOAD_SVG,
  COPY_SVG,
  deployBadge,
} from "./icons";
import { RuntimeLogs } from "./logs";
import type { AppDetailInfo } from "./panel";

/** Deploy (git remote) card dropdown. Lives in the page header next to
 * Code so it works on every tab; loads its own detail via the shared SWR
 * key. CSS-only dropdown (focus-based) — no visibility atom needed. */
export const DeployDropdown = ({ appId }: { appId: string }) => {
  const detail = atom<AppDetailInfo | null>(
    readSwrCache<AppDetailInfo>(`app:${appId}:detail`)
  );
  watch.once(() => {
    void (async () => {
      try {
        const info = await get(appId);
        detail.set(info);
        writeSwrCache(`app:${appId}:detail`, info);
      } catch {
        // Header modal stays shut without data.
      }
    })();
  });

  const info = detail();
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
          {unsafe(CLOUD_UPLOAD_SVG)}
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
              {unsafe(copied() ? CHECK_SVG : COPY_SVG)}
            </button>
          </div>
          <p class="m-0 text-sm opacity-80">
            Stock Git over HTTP — push <code>main</code> to deploy. Auth:{" "}
            <code>username={info.username}</code>, password = API key from{" "}
            <a href="/profile" class="link">
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
                      redeployError.set(
                        error instanceof Error ? error.message : String(error)
                      );
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

const DeployRow = ({
  appId,
  currentSha,
  d,
}: {
  appId: string;
  currentSha: string | null;
  d: RunnerDeploy;
  key?: string;
}) => {
  // Atom-driven expansion (no native <details>): ilha binds no `ontoggle`
  // event and stream re-renders would wipe native open state shut.
  // The log is a sibling <li> (block layout, full width by construction)
  // instead of a grid child — immune to list-row span subtleties.
  // The current deployment starts expanded.
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
                  rollError.set(
                    error instanceof Error ? error.message : String(error)
                  );
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
            {unsafe(open() ? CHEVRON_UP_SVG : CHEVRON_DOWN_SVG)}
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
          {logTab() === "deploy" ? (
            <div class="bg-base-200 rounded-lg p-3">
              <RuntimeLogs
                appId={appId}
                logId={`deploy-logs-${d.sha ?? d.id}`}
              />
            </div>
          ) : (
            <div class="bg-base-200 rounded-lg p-3">
              <pre class="max-h-64 overflow-auto rounded font-mono text-xs whitespace-pre-wrap">
                {d.log || "(no log)"}
              </pre>
            </div>
          )}
        </li>
      ) : null}
    </>
  );
};

/** Deploy history over SSE (like RuntimeLogs): cache-first seed paints
 * instantly on every mount, then the event stream pushes updates and
 * rewrites the cache — no polling, and rows never remount underneath
 * an open log. */
export const DeployList = ({ appId }: { appId: string }) => {
  const seed = readSwrCache<RunnerDeploy[]>(`app:${appId}:deploys`);
  const items = atom<RunnerDeploy[]>(seed ?? []);
  const loadError = atom("");
  const loaded = atom(seed !== null);
  const detail = atom<AppDetailInfo | null>(
    readSwrCache<AppDetailInfo>(`app:${appId}:detail`)
  );
  watch.once(() => {
    void (async () => {
      try {
        const info = await get(appId);
        detail.set(info);
        writeSwrCache(`app:${appId}:detail`, info);
      } catch {
        // Detail only hides the current row's rollback; rows render regardless.
      }
    })();
    let stopped = false;
    const source = new EventSource(
      `/api/apps/${encodeURIComponent(appId)}/deploys/stream`
    );
    source.addEventListener("message", (event) => {
      // A frame arrived, so the stream is alive — even when the payload
      // matches (empty history with no seed would stick on the skeleton).
      loaded.set(true);
      try {
        const next: unknown = JSON.parse(event.data);
        if (!Array.isArray(next)) {
          return;
        }
        if (JSON.stringify(items()) === JSON.stringify(next)) {
          return;
        }
        // SAFETY: the runner deploys stream emits the same Deploy rows as
        // the list endpoint; entries flow only into list rendering.
        items.set(next as RunnerDeploy[]);
        writeSwrCache(`app:${appId}:deploys`, next);
        loadError.set("");
      } catch {
        loadError.set("Deploy stream sent invalid data");
      }
    });
    source.addEventListener("error", () => {
      if (!stopped) {
        loadError.set("Deploy stream disconnected — retrying…");
      }
      loaded.set(true);
    });
    return () => {
      stopped = true;
      source.close();
    };
  });
  return (
    <div class="flex w-full flex-col gap-4">
      {loadError() ? <p class="text-error m-0 text-sm">{loadError()}</p> : null}
      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Deployments</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
        </li>
        {!loaded() && items().length === 0 && !loadError() ? (
          <li class="px-4 pt-2 pb-4">
            <ListSkeleton rows={2} />
          </li>
        ) : null}
        {loaded() && items().length === 0 && !loadError() ? (
          <li class="text-base-content/70 px-4 pt-2 pb-4 text-sm">
            No deployments yet. Push to main to trigger one.
          </li>
        ) : null}
        {items().map((d) => (
          <DeployRow
            key={d.id}
            appId={appId}
            currentSha={detail()?.app.lastDeploySha ?? null}
            d={d}
          />
        ))}
      </ul>
    </div>
  );
};
