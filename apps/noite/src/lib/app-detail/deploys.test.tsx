import { beforeEach, describe, expect, test } from "bun:test";

import { renderHtml } from "ilha/test";

import type { AppDetail } from "../api-types";
import { keys } from "../resources";
import type { RunnerDeploy } from "../runner";
import { clearSwrStore, writeSwr } from "../swr-store";
import { DeployRow } from "./deploys";
import { AppHeader } from "./panel";

const APP_ID = "app-rollback";
const LIVE = "63a16014442f15e80e87c77e1b39f43eef4a2804";

const detail = (lastDeploySha: string | null): AppDetail => ({
  app: {
    asleepSince: null,
    autoDeploy: { state: "eligible" },
    createdAt: "2026-11-10T13:27:02.395Z",
    desiredState: "running",
    fleetBucket: "s3://noite-e2e/fleets/rollback",
    gitPrefix: "git/rollback/",
    id: APP_ID,
    imported: false,
    internalPort: 20_005,
    lastDeploySha,
    lastError: null,
    listenPort: 20_004,
    name: "Rollback",
    slug: "rollback",
    status: "running",
    subdomain: "rollback.noite.localhost",
    updatedAt: "2026-11-10T13:27:12.137Z",
    userId: "user-e2e",
    wokeAt: null,
  },
  gitHint: "",
  gitRemote: "http://localhost:8080/v1/git/rollback",
  host: "noite.localhost:8090",
  myRole: "admin",
  s3Endpoint: "http://localhost:19000",
  username: "rollback",
});

/** The header at module scope so the server render resolves it. */
const Header = () => <AppHeader appId={APP_ID} />;

const STOPPED: RunnerDeploy = {
  actor: null,
  appId: APP_ID,
  createdAt: "2026-11-10T13:27:02.395Z",
  environmentId: null,
  error: "cancelled by the operator",
  id: "deploy-stopped",
  intent: "deploy",
  log: "",
  sha: LIVE,
  status: "cancelled",
  updatedAt: "2026-11-10T13:28:44.395Z",
};

/** What the Deployments tab paints for one stopped deploy: the app page's
 * header above the tab, then the deploy's own row. */
const DeploymentsProbe = () => (
  <div>
    <AppHeader appId={APP_ID} />
    <DeployRow
      appId={APP_ID}
      canPush={false}
      currentSha={LIVE}
      d={STOPPED}
      environmentId=""
      live={false}
    />
  </div>
);

describe("AppHeader", () => {
  beforeEach(() => {
    clearSwrStore();
  });

  // Identity, not layout: the action row gains a Stop/Start (or Retry import)
  // control when the app detail lands — a stale snapshot paints "Not deployed"
  // first, and e2e focuses the Deploy control inside that window. Positional
  // matching paired the new button with the menu's div and replaced the
  // subtree, closing the menu and dropping its state (rollback.spec.ts). The
  // keys make ilha's morph move the live nodes instead, so the pin is the
  // attribute.
  test("keys the action row so a status control cannot replace the menu", async () => {
    writeSwr(keys.appDetail(APP_ID), detail(LIVE));

    const html = await renderHtml(Header);

    expect(html).toContain('data-ilha-key="visit"');
    expect(html).toContain('data-ilha-key="power"');
    expect(html).toContain('data-ilha-key="deploy"');
  });

  // A stopped deploy's reason lives on its own row. It used to be copied onto
  // the app's `last_error`, which painted the same sentence in a second alert
  // above every tab; the runner now keeps `last_error` for failures the deploy
  // history cannot show. The card must still say why, and say it once.
  test("a stopped deploy shows its reason and duration in its card, once", async () => {
    writeSwr(keys.appDetail(APP_ID), detail(LIVE));

    const html = await renderHtml(DeploymentsProbe);

    expect(html).toContain("took 1m 42s");
    expect(html.split("cancelled by the operator")).toHaveLength(2);
  });
});
