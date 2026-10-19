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
import { Onboarding } from "./auth/onboarding";
import { keys } from "./resources";
import type { SourceBrowserState } from "./source/drafts";
import { PreviewPanel } from "./source/preview-panel";
import { writeSwr } from "./swr-store";

const APP_ID = "ssr-probe";

// Named (not inline): renderHtml resolves anonymous closures without their
// imports, so only a module-level component renders the real tree.
const PreviewProbe = () => (
  <PreviewPanel
    appId={APP_ID}
    branch="main"
    onClose={() => {}}
    onDeployPreview={() => Promise.resolve(null)}
    state={atom<SourceBrowserState>({
      conflicts: [],
      files: [],
      previewed: null,
      pushError: "",
      pushed: null,
      pushing: false,
      readOnly: "",
      revision: 0,
      stale: null,
    })}
  />
);

beforeEach(() => {
  // Seed the app read so SSR gets past the panel's skeleton: without it the
  // frame (where the browser-global access lives) never renders.
  writeSwr(keys.appDetail(APP_ID), {
    app: {
      asleepSince: null,
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
  test("the create form renders without browser globals", async () => {
    const html = await renderHtml(CreateAppForm);
    expect(html).not.toContain("data-ilha-error");
    expect(html).toContain("Create app");
  });

  test("onboarding renders without browser globals", async () => {
    const html = await renderHtml(Onboarding);
    expect(html).not.toContain("data-ilha-error");
  });

  test("the preview panel renders without browser globals", async () => {
    const html = await renderHtml(PreviewProbe);
    expect(html).not.toContain("data-ilha-error");
    expect(html).toContain("probe");
  });
});
