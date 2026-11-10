import { beforeEach, describe, expect, test } from "bun:test";

import { renderHtml } from "ilha/test";

import type { AppDetail } from "../api-types";
import { keys } from "../resources";
import { clearSwrStore, writeSwr } from "../swr-store";
import { AppHeader } from "./panel";

const APP_ID = "app-rollback";
const LIVE = "63a16014442f15e80e87c77e1b39f43eef4a2804";

const detail = (lastDeploySha: string | null): AppDetail => ({
  app: {
    asleepSince: null,
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
});
