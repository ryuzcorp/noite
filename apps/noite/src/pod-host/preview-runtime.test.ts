/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, eslint/require-await -- this file is a test double: a scripted spawner and a checkout stub, mirroring `startPreview`'s own async surface and the frame's `fs` slice */
import { describe, expect, test } from "bun:test";

import type { PodPreviewLog } from "../lib/source/pod-protocol";
import { planPreview } from "../lib/source/preview/plan";
import type {
  PreviewHandle,
  PreviewOptions,
  PreviewPlan,
} from "../lib/source/preview/types";
import { projectPath } from "../lib/source/workspace/types";
import type { WorkspaceFs } from "../lib/source/workspace/types";
import type { FrameWorkspace } from "../lib/source/workspace/workspace";
import { createPreviewRuntime } from "./preview-runtime";
import type { PreviewStarter } from "./preview-runtime";

/** The frame's own origin, which the runtime is handed rather than reading
 * `location` (a bun test has none). */
const ORIGIN = "https://app-0.preview.demo.example";
const ON_ORIGIN = `${ORIGIN}/__virtual__/instance/5173/`;
const OFF_ORIGIN = "https://elsewhere.example/__virtual__/instance/5173/";

/** A checkout with a dev script and nothing the browser cannot run, so the
 * real planner answers `dev`. */
const CHECKOUT_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    devDependencies: { vite: "^8.3.2" },
    name: "demo",
    scripts: { dev: "vite" },
  }),
};

/** The checkout as the runtime reads it: only `fs.exists` and `fs.readFile`,
 * for the plan's files. */
const checkout = (
  files: Record<string, string> = CHECKOUT_FILES
): FrameWorkspace => {
  const byPath = new Map(
    Object.entries(files).map(([path, text]) => [projectPath(path), text])
  );
  const fs = {
    exists: (path: string) => Promise.resolve(byPath.has(path)),
    readFile: (path: string) => Promise.resolve(byPath.get(path) ?? ""),
  } as unknown as WorkspaceFs;
  // SAFETY: the runtime reads only these two: the plan's files off `fs`, and
  // `pod` only to hand it to the injected starter.
  return { fs, pod: null } as unknown as FrameWorkspace;
};

/** A preview launch the test scripts: what a spawned process would print, the
 * URL it would answer on, and whether it fails instead. */
interface Spawn {
  failure?: string;
  logs?: [PodPreviewLog["stream"], string][];
  restartFailure?: string;
  url: string;
}

/** The fake spawner, as the tests read it back. */
interface Spawner {
  calls: PreviewPlan[];
  restarts: () => number;
  start: PreviewStarter;
  stops: () => number;
}

/** The fake spawner: it records every launch and reports readiness the way
 * `startPreview` does — through `onState`/`onLog`, then a handle. `scripts`
 * is what each launch answers with, oldest first. */
const spawner = (scripts: Spawn[]): Spawner => {
  const queue = [...scripts];
  const calls: PreviewPlan[] = [];
  let restarts = 0;
  let stops = 0;
  return {
    calls,
    restarts: () => restarts,
    start: async (pod, spawned, options: PreviewOptions) => {
      void pod;
      calls.push(spawned);
      const script = queue.shift() ?? { url: ON_ORIGIN };
      options.onState("installing", "installing the app's dependencies");
      if (script.failure !== undefined) {
        throw new Error(script.failure);
      }
      for (const [stream, text] of script.logs ?? []) {
        options.onLog(text, stream);
      }
      options.onState("starting", "running the app's dev script");
      options.onState("ready", script.url);
      const handle: PreviewHandle = {
        processes: () => ["npm run dev"],
        restart: () => {
          restarts += 1;
          if (script.restartFailure !== undefined) {
            return Promise.reject(new Error(script.restartFailure));
          }
          return Promise.resolve();
        },
        stop: () => {
          stops += 1;
          return Promise.resolve();
        },
        url: script.url,
      };
      return handle;
    },
    stops: () => stops,
  };
};

const runtime = (
  start: PreviewStarter,
  plan: (files: ReadonlyMap<string, string>) => PreviewPlan = planPreview
) =>
  createPreviewRuntime({
    origin: () => ORIGIN,
    plan,
    start,
  });

/** Run one test against a scripted spawner. */
const withSpawner = async (
  run: (fake: Spawner) => Promise<void>,
  scripts: Spawn[] = [{ url: ON_ORIGIN }]
): Promise<void> => {
  await run(spawner(scripts));
};

describe("the frame's preview runtime", () => {
  test("plans the checkout and starts it, streaming what it says", async () => {
    await withSpawner(async (fake) => {
      const preview = runtime(fake.start);
      const logs: PodPreviewLog[] = [];
      preview.onLog((line) => {
        logs.push(line);
      });
      let notifications = 0;
      preview.subscribe(() => {
        notifications += 1;
      });
      preview.attach(checkout());
      await preview.open();
      const view = preview.view();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.mode).toBe("dev");
      expect(view.state).toBe("ready");
      expect(view.url).toBe(ON_ORIGIN);
      expect(view.detail).toBe(ON_ORIGIN);
      expect(view.error).toBe("");
      expect(view.processes).toEqual(["npm run dev"]);
      // `onState` is the detail above; only `onLog` fills the pane.
      expect(view.logs).toEqual([]);
      expect(notifications).toBeGreaterThan(0);
      expect(logs).toEqual([]);
      await preview.stop();
      expect(fake.stops()).toBe(1);
      expect(preview.view().state).toBe("idle");
      expect(preview.view().url).toBe("");
    });
  });

  test("refuses a preview URL that is not on this document's origin", async () => {
    await withSpawner(
      async (fake) => {
        const preview = runtime(fake.start);
        preview.attach(checkout());
        await preview.open();
        const view = preview.view();
        expect(view.state).toBe("error");
        expect(view.error).toContain(ORIGIN);
        // The server the pod started is not left behind, and no iframe ever
        // frames it.
        expect(fake.stops()).toBe(1);
        expect(view.url).toBe("");
      },
      [{ url: OFF_ORIGIN }]
    );
  });

  test("reports a start that threw, verbatim", async () => {
    await withSpawner(
      async (fake) => {
        const preview = runtime(fake.start);
        preview.attach(checkout());
        await preview.open();
        expect(preview.view().state).toBe("error");
        expect(preview.view().error).toBe("npm exited with code 1");
      },
      [{ failure: "npm exited with code 1", url: ON_ORIGIN }]
    );
  });

  test("reports a plan it cannot make, without starting anything", async () => {
    await withSpawner(async (fake) => {
      const preview = runtime(fake.start, () => {
        throw new Error("preview: the manifest is not readable");
      });
      preview.attach(checkout());
      await preview.open();
      expect(preview.view().state).toBe("error");
      expect(preview.view().error).toBe(
        "preview: the manifest is not readable"
      );
      expect(fake.calls).toEqual([]);
    });
  });

  test("drops a handle whose restart failed, and starts afresh next time", async () => {
    await withSpawner(
      async (fake) => {
        const preview = runtime(fake.start);
        preview.attach(checkout());
        await preview.open();
        expect(preview.view().state).toBe("ready");
        await preview.restart();
        // The server the restart halted is gone: the URL it framed is stale,
        // and a "Ready" over it would lie.
        expect(preview.view().state).toBe("error");
        expect(preview.view().error).toBe("the restart broke");
        expect(preview.view().url).toBe("");
        expect(fake.restarts()).toBe(1);
        // With no handle left, a restart is a fresh start.
        await preview.restart();
        expect(preview.view().state).toBe("ready");
        expect(fake.calls).toHaveLength(2);
      },
      [
        { restartFailure: "the restart broke", url: ON_ORIGIN },
        { url: ON_ORIGIN },
      ]
    );
  });

  test("keeps the last 500 lines the preview printed", async () => {
    await withSpawner(
      async (fake) => {
        const preview = runtime(fake.start);
        preview.attach(checkout());
        await preview.open();
        const lines: PodPreviewLog[] = [];
        preview.onLog((line) => {
          lines.push(line);
        });
        // A second launch after the first stopped: its own log is reset, and
        // the pane keeps the tail of the 600 lines it printed.
        await preview.stop();
        await preview.open();
        const printed = preview.view().logs;
        expect(printed).toHaveLength(500);
        expect(printed[0]?.text).toBe("install 101/600");
        expect(printed.at(-1)?.text).toBe("install 600/600");
        expect(lines).toHaveLength(600);
      },
      [
        { url: ON_ORIGIN },
        {
          logs: Array.from(
            { length: 600 },
            (_, index) =>
              ["stdout", `install ${index + 1}/600`] as [
                PodPreviewLog["stream"],
                string,
              ]
          ),
          url: ON_ORIGIN,
        },
      ]
    );
  });

  test("stops a running preview when the checkout goes away", async () => {
    await withSpawner(async (fake) => {
      const preview = runtime(fake.start);
      preview.attach(checkout());
      await preview.open();
      await preview.detach();
      expect(fake.stops()).toBe(1);
      expect(preview.view().state).toBe("idle");
      // Nothing is attached any more: `open` has nothing to plan.
      await preview.open();
      expect(fake.calls).toHaveLength(1);
    });
  });
});
