//! The one decision the Preview panel makes before it starts anything: what
//! this checkout should run, and what it will have to do without. The rule,
//! in order: the app's own `dev` script when the browser can run it; a
//! plugin-less Vite build when the app is a Vite app with the Cloudflare
//! plugin; the Worker entry served straight from the pod; an assets
//! directory. Everything the chosen mode cannot do becomes a note, so a
//! degraded preview is never silent.

import { nativeDeps, previewConfig } from "./config";
import type { PreviewConfig } from "./config";
import type { PreviewPlan, PreviewMode } from "./types";

/** The sentences the plan hands the panel. They are exported so the panel and
 * its e2e assert on one spelling instead of two. */
export const PREVIEW_NOTES = {
  /** The build is ours, not the app's: its Vite plugins and the aliases they
   * add are not applied. */
  generatedViteConfig:
    "Preview builds with a generated Vite config: plugins and aliases from vite.config.* are not applied",
  /** Poder runs the Worker's bindings locally: one location, no output
   * gates, and no WebSocket upgrades through the preview host. */
  localBindings:
    "Preview bindings run locally in the browser: a single location with no output gates",
  nothingToRun:
    "Nothing to run in Preview: the checkout has no dev script, Worker entry or assets directory",
  secrets: "Secrets are not available in Preview",
} satisfies Record<string, string>;

/** The Cloudflare Vite plugin, in either dependency map: it pulls in
 * `workerd`, which cannot run in the pod. */
const hasCloudflarePlugin = (config: PreviewConfig): boolean =>
  config.devDependencies["@cloudflare/vite-plugin"] !== undefined ||
  config.dependencies["@cloudflare/vite-plugin"] !== undefined;

/** A Vite app is one that has a Vite config or a client `index.html`. */
const isViteApp = (config: PreviewConfig): boolean =>
  config.hasViteConfig || config.hasIndexHtml;

/** The bindings a mode serves locally, one note each. Secrets need no binding
 * to be a limit: the pod is the user's browser, so none is ever passed in.
 * Poder serves D1, KV, R2 and Durable Objects in the browser, which is an
 * approximation worth one line. */
const limitationNotes = (config: PreviewConfig): string[] => {
  const notes: string[] = [];
  if (
    config.bindings.some(
      (binding) =>
        binding.kind === "d1" ||
        binding.kind === "kv" ||
        binding.kind === "r2" ||
        binding.kind === "durable-object"
    )
  ) {
    notes.push(PREVIEW_NOTES.localBindings);
  }
  if (config.bindings.some((binding) => binding.kind === "secret")) {
    notes.push(PREVIEW_NOTES.secrets);
  }
  return notes;
};

interface Choice {
  mode: PreviewMode;
  notes: string[];
  reason: string;
}

const chooseMode = (config: PreviewConfig, native: string[]): Choice => {
  // Only a mode that would have run the dev script has to explain why it does
  // not: without a dev script the native dependency is simply unused.
  const nativeNote =
    native.length === 0 || config.dev === null
      ? null
      : `Preview cannot run ${native.join(", ")} (a native binary), so the dev script is not used`;
  const notes = nativeNote === null ? [] : [nativeNote];
  if (config.dev !== null && native.length === 0) {
    return {
      mode: "dev",
      notes: [],
      reason: `package.json runs its own dev server (\`${config.dev}\`)`,
    };
  }
  if (hasCloudflarePlugin(config) && isViteApp(config)) {
    return {
      mode: "vite-build",
      notes: [...notes, PREVIEW_NOTES.generatedViteConfig],
      reason:
        "@cloudflare/vite-plugin needs workerd, which cannot run here: the client and the Worker are built without it",
    };
  }
  if (config.entry !== null) {
    return {
      mode: "worker",
      notes,
      reason: `the Worker entry ${config.entry} is bundled (plugins are not applied) and served`,
    };
  }
  if (config.assets !== null) {
    return {
      mode: "static",
      notes,
      reason: `no Worker entry or dev script: serving the assets in ${config.assets}/`,
    };
  }
  return {
    mode: "static",
    notes: [...notes, PREVIEW_NOTES.nothingToRun],
    reason: "no dev script, Worker entry or assets directory was found",
  };
};

/** The rule itself, over an already-read config — `startPreview` reads the
 * pod's own copies and plans the same way. */
const planFor = (config: PreviewConfig): PreviewPlan => {
  const native = nativeDeps(config);
  const choice = chooseMode(config, native);
  const notes = [
    ...limitationNotes(config),
    ...choice.notes,
    ...config.unreadable,
  ];
  return { mode: choice.mode, notes, reason: choice.reason };
};

/** Decide how to preview a checkout's files. `files` maps config file paths
 * (checkout-relative, e.g. `package.json`) to their text. */
export const planPreview = (files: ReadonlyMap<string, string>): PreviewPlan =>
  planFor(previewConfig(files));
