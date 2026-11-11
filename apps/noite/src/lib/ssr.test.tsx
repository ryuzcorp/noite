//! SSR regression: the control UI server-renders every page, so components
//! must not touch browser globals while `watch`/`watch.once` callbacks run
//! (ilha subscribes with `immediate: true`, including on the server). Each
//! test renders an affected component with `renderHtml` (DOM-free, like the
//! worker) and fails if ilha paints its error view instead of the component.

import { beforeEach, describe, expect, test } from "bun:test";

import { atom } from "ilha";
import { renderHtml } from "ilha/test";

import type { AppDetail } from "./api-types";
import { CreateAppForm } from "./apps/create-form";
import { AppsList } from "./apps/list";
import { Onboarding } from "./auth/onboarding";
import { keys } from "./resources";
import { ChangesPanel } from "./source/changes";
import type { SourceBrowserState } from "./source/drafts";
import { writeSwr } from "./swr-store";

const APP_ID = "ssr-probe";

// Named (not inline): renderHtml resolves anonymous closures without their
// imports, so only a module-level component renders the real tree.
const ChangesProbe = () => (
  <ChangesPanel
    appId={APP_ID}
    branch="main"
    branches={[]}
    commit={() => Promise.resolve(false)}
    defaultBranch="main"
    discard={() => {}}
    discardAll={() => {}}
    isProtected={() => false}
    restore={() => {}}
    state={atom<SourceBrowserState>({
      files: [],
      pushError: null,
      pushed: null,
      pushing: false,
      readOnly: "",
      revision: 0,
    })}
  />
);

beforeEach(() => {
  // Seed the app read so SSR gets past the panel's skeleton: without it the
  // frame (where the browser-global access lives) never renders.
  writeSwr(keys.appDetail(APP_ID), {
    app: {
      asleepSince: null,
      autoDeploy: { state: "eligible" },
      createdAt: "",
      desiredState: "running",
      fleetBucket: "",
      gitPrefix: "",
      id: APP_ID,
      imported: false,
      internalPort: null,
      lastDeploySha: "abc1234",
      lastError: null,
      listenPort: null,
      name: "Probe",
      slug: "probe",
      status: "running",
      subdomain: "probe",
      updatedAt: "",
      userId: "u1",
      wokeAt: null,
    },
    gitHint: "",
    gitRemote: "",
    host: "",
    myRole: "admin",
    s3Endpoint: "",
    username: "",
  } satisfies AppDetail);
});

describe("ssr", () => {
  test("the create form renders without browser globals, controls inert", async () => {
    const html = await renderHtml(CreateAppForm);
    expect(html).not.toContain("data-ilha-error");
    expect(html).toContain("Create app");
    // No handlers exist until the island mounts, so the whole form is disabled.
    expect(html).toContain('disabled=""');
  });

  test("onboarding renders without browser globals", async () => {
    const html = await renderHtml(Onboarding);
    expect(html).not.toContain("data-ilha-error");
  });

  test("a live panel paints its loading state before the client mounts", async () => {
    // A server render has not tried to open a stream, so the panel is
    // `Cold` (a skeleton). Painting `Offline` here was an error over a load
    // that had not even started: the client's own mount subscribes, and only
    // a browser without EventSource is genuinely offline.
    const html = await renderHtml(AppsList);

    expect(html).not.toContain("data-ilha-error");
    expect(html).toContain("skeleton");
    expect(html).not.toContain("Live updates are unavailable");
  });

  test("the changes panel renders without browser globals", async () => {
    const html = await renderHtml(ChangesProbe);
    expect(html).not.toContain("data-ilha-error");
    expect(html).toContain("Commit message");
  });
});
