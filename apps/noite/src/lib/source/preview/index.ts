//! The preview runtime's entry point: `planPreview` decides what a checkout
//! runs, `startPreview` runs it in the pod and answers with the URL the panel
//! puts in its iframe. Everything exported here is safe to import from the
//! app; a Node consumer (a Playwright spec) should import `./plan` for
//! `PREVIEW_NOTES` and the planner, because `startPreview` reaches for the
//! pod's own browser APIs.

export { PREVIEW_NOTES, planPreview } from "./plan";
export { startPreview } from "./start";
export type {
  PreviewHandle,
  PreviewLogStream,
  PreviewMode,
  PreviewOptions,
  PreviewPlan,
  PreviewPod,
  PreviewState,
} from "./types";
