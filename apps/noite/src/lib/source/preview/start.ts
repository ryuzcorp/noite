//! Starting a preview: read the checkout's own config out of the pod, put the
//! harness beside Noite's metadata, install what the chosen mode will load,
//! spawn it, and wait until something answers on a pod port. `dev` hands the
//! whole thing to the app's own dev server; `vite-build` builds the client
//! and the Worker without the Cloudflare plugin (which needs `workerd`);
//! `worker` bundles the Worker entry with Vite (no plugins) and serves that —
//! the pod only strips the simplest TypeScript, so the entry is never served
//! raw; `static` serves an assets directory. Nothing here ever tears the pod
//! down — the pod is the workspace, and the panel closing is not the workspace
//! closing.

import { PROJECT_ROOT } from "../workspace/types";
import { previewConfig } from "./config";
import type { PreviewConfig } from "./config";
import {
  HARNESS_CACHE_DIR,
  HARNESS_DIR,
  HARNESS_SERVER,
  writeHarness,
  writeViteConfigs,
} from "./harness";
import {
  entryPackages,
  installManifest,
  installPackages,
  installTooling,
  pathAliases,
  SRVX_VERSION,
} from "./install";
import type { InstallRun } from "./install";
import { freePort, whenFileExists, whenServerReady } from "./ports";
import type { ReadyServer } from "./ports";
import { liveCommands } from "./processes";
import type {
  PreviewHandle,
  PreviewOptions,
  PreviewPlan,
  PreviewPod,
  PreviewProcess,
} from "./types";

/** Where a preview's virtual servers start: above the ports a workspace's own
 * tools use, and above the base the feasibility runs used. */
const PREVIEW_PORT_BASE = 4444;

/** The port a Vite dev script is asked to use; a dev server that ignores the
 * request still works, because the pod announces whatever port it picks. */
const DEV_PORT = 5173;

/** The Vite CLI the preview builds with: the preview's own tooling, beside
 * the generated server, not the app's. */
const VITE_BIN = `${HARNESS_DIR}/node_modules/vite/bin/vite.js`;

/** The Vite a build uses when the app declares none (a plain Worker). */
const DEFAULT_VITE_VERSION = "^8.3.2";

/** How long after the last filesystem event a restart happens. */
const RESTART_DEBOUNCE_MS = 250;

/** Paths a restart never comes from: the installer's, git's, Noite's own
 * metadata, and the build output a watched process writes. */
const IGNORED_EVENT =
  /(?:^|\/)(?:\.cache|\.git|\.noite|\.wrangler|node_modules)(?:\/|$)/u;

/** Files read out of the checkout to plan and configure a preview. */
const PROBED_FILES = [
  "package.json",
  "cloudflare.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
  "tsconfig.json",
  "index.html",
  "src/index.ts",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
  "build/index.html",
  "build/404.html",
  "dist/index.html",
  "dist/404.html",
  "out/index.html",
  "out/404.html",
] as const;

/** The checkout's own copies of the files a plan is made from. The reads are
 * independent, so they all go out at once. */
const readCheckout = async (pod: PreviewPod): Promise<Map<string, string>> => {
  const present = await Promise.all(
    PROBED_FILES.map(async (path): Promise<[string, string] | null> => {
      const absolute = `${PROJECT_ROOT}/${path}`;
      if (!(await pod.fs.exists(absolute))) {
        return null;
      }
      return [path, await pod.fs.readFile(absolute, "utf-8")];
    })
  );
  const files = new Map<string, string>();
  for (const entry of present) {
    if (entry !== null) {
      files.set(entry[0], entry[1]);
    }
  }
  return files;
};

/** The assets directory of a checkout, as an absolute pod path. */
const absoluteAssets = (config: PreviewConfig): string | null =>
  config.assets === null ? null : `${PROJECT_ROOT}/${config.assets}`;

/** What `requestRestart` is before any watcher exists: the checkout is not
 * watched yet, so a file event cannot have come from one. */
const NOTHING_WATCHING_YET = (): void => {
  // Replaced as soon as `launch` has installed a watcher.
};

export const startPreview = async (
  pod: PreviewPod,
  plan: PreviewPlan,
  opts: PreviewOptions
): Promise<PreviewHandle> => {
  const config = previewConfig(await readCheckout(pod));
  const port = freePort(
    pod,
    plan.mode === "dev" ? DEV_PORT : PREVIEW_PORT_BASE
  );
  const run: InstallRun = { onLog: opts.onLog };
  const processes: PreviewProcess[] = [];
  /** One line per live child: the terminal's `preview` command reads these,
   * and an exit takes its own line back out. */
  const commands = liveCommands();
  const watchers: { close: () => void }[] = [];
  const pendingLines: Record<"stderr" | "stdout", string> = {
    stderr: "",
    stdout: "",
  };
  let server: ReadyServer = { port, url: "" };
  let stopped = false;
  let debounce: number | null = null;
  let restarting = false;
  let queued = false;
  /** Installed once the debounce below exists: launching a watcher and the
   * debounce that restarts it reference each other, so the launcher calls
   * through this. */
  let requestRestart: () => void = NOTHING_WATCHING_YET;

  const lineLogger =
    (stream: "stdout" | "stderr") =>
    (chunk: string): void => {
      pendingLines[stream] += chunk;
      const lines = pendingLines[stream].split("\n");
      pendingLines[stream] = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          opts.onLog(line, stream);
        }
      }
    };

  const spawn = async (cmd: string, args: string[]): Promise<void> => {
    const line = [cmd, ...args].join(" ");
    opts.onLog(`$ ${line}`, "system");
    const child = await pod.spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      signal: opts.signal,
    });
    child.on("output", lineLogger("stdout"));
    child.on("error", lineLogger("stderr"));
    commands.add(child, line);
    child.on("exit", (code) => {
      commands.remove(child);
      if (!stopped && code !== 0) {
        opts.onState("error", `${cmd} exited with code ${code}`);
      }
    });
    processes.push(child);
  };

  const awaitReady = async (waiting: Promise<ReadyServer>): Promise<void> => {
    const listening = await waiting;
    server = listening;
    opts.onState("ready", listening.url);
  };

  const watch = (path: string, onEvent: () => void): void => {
    watchers.push(
      pod.fs.watch(path, { recursive: true }, (_event, filename) => {
        if (filename !== null && IGNORED_EVENT.test(filename)) {
          return;
        }
        onEvent();
      })
    );
  };

  const requireEntry = (): string => {
    if (config.entry === null) {
      throw new Error(
        "preview: this checkout declares no Worker entry (package.json main, cloudflare.config.ts entrypoint or wrangler main)"
      );
    }
    return config.entry;
  };

  const installWorkerImports = async (entry: string): Promise<void> => {
    opts.onState("installing", "installing what the Worker entry imports");
    const aliases = await pathAliases(pod.fs);
    const packages = await entryPackages(pod.fs, entry, aliases);
    opts.onLog(
      packages.length === 0
        ? "preview: the Worker entry imports no packages"
        : `preview: the Worker entry imports ${packages.join(", ")}`,
      "system"
    );
    await installPackages(
      pod,
      packages.map((name) => ({
        name,
        version: config.dependencies[name] ?? config.devDependencies[name],
      })),
      run
    );
  };

  /** The server every built/bundled mode spawns imports `srvx`, and the build
   * itself needs `vite`: one tooling install covers both, in the harness
   * directory, so neither touches the app's own dependencies. */
  const ensureVite = async (): Promise<void> => {
    await installTooling(
      pod,
      {
        srvx: SRVX_VERSION,
        vite:
          config.devDependencies.vite ??
          config.dependencies.vite ??
          DEFAULT_VITE_VERSION,
      },
      run
    );
    if (!(await pod.fs.exists(VITE_BIN))) {
      throw new Error(`preview: vite is not at ${VITE_BIN} after installing`);
    }
  };
  const launchBuild = async (again: boolean): Promise<void> => {
    const entry = requireEntry();
    if (!again) {
      opts.onState("installing", "installing the build's dependencies");
      if (Object.keys(config.dependencies).length > 0) {
        await installManifest(pod, {
          manifest: `${PROJECT_ROOT}/package.json`,
          run,
          withDevDeps: false,
        });
      }
      await ensureVite();
    }
    const dirs = await writeViteConfigs(pod.fs, `${PROJECT_ROOT}/${entry}`);
    // Before the build: the Worker bundle aliases `cloudflare:workers` at
    // Poder's shim, so its files have to exist when Vite resolves.
    await writeHarness(pod.fs, {
      assets: dirs.clientDir,
      bindings: config.bindings,
      entry: `${dirs.workerDir}/index.js`,
      notFoundHandling: config.notFoundHandling,
      port,
    });
    await pod.fs.rm(HARNESS_CACHE_DIR, { force: true, recursive: true });
    opts.onState(
      "building",
      "building the client and the Worker without @cloudflare/vite-plugin"
    );
    await spawn("node", [
      VITE_BIN,
      "build",
      "--watch",
      "--config",
      dirs.client,
    ]);
    await spawn("node", [
      VITE_BIN,
      "build",
      "--watch",
      "--config",
      dirs.worker,
    ]);
    await whenFileExists(pod, `${dirs.clientDir}/index.html`, {
      signal: opts.signal,
    });
    await whenFileExists(pod, `${dirs.workerDir}/index.js`, {
      signal: opts.signal,
    });
    const waiting = whenServerReady(pod, { port, signal: opts.signal });
    opts.onState("starting", "serving the built client and Worker");
    await spawn("node", [HARNESS_SERVER]);
    await awaitReady(waiting);
    // The watched Worker build rewrites its bundle in place; the server
    // imports it once, so a new bundle means a new server.
    watch(dirs.workerDir, requestRestart);
  };

  const launchWorker = async (again: boolean): Promise<void> => {
    const entry = `${PROJECT_ROOT}/${requireEntry()}`;
    if (!again) {
      await installWorkerImports(entry);
      opts.onState("installing", "installing the Worker's build");
      await ensureVite();
    }
    const dirs = await writeViteConfigs(pod.fs, entry);
    // Before the build: the Worker bundle aliases `cloudflare:workers` at
    // Poder's shim, so its files have to exist when Vite resolves.
    await writeHarness(pod.fs, {
      assets: absoluteAssets(config),
      bindings: config.bindings,
      entry: `${dirs.workerDir}/index.js`,
      notFoundHandling: config.notFoundHandling,
      port,
    });
    await pod.fs.rm(HARNESS_CACHE_DIR, { force: true, recursive: true });
    opts.onState("building", `bundling ${config.entry ?? "the Worker entry"}`);
    await spawn("node", [
      VITE_BIN,
      "build",
      "--watch",
      "--config",
      dirs.worker,
    ]);
    await whenFileExists(pod, `${dirs.workerDir}/index.js`, {
      signal: opts.signal,
    });
    const waiting = whenServerReady(pod, { port, signal: opts.signal });
    opts.onState("starting", `serving ${config.entry ?? "the Worker"}`);
    await spawn("node", [HARNESS_SERVER]);
    await awaitReady(waiting);
    // The watched Worker build rewrites its bundle in place; the server
    // imports it once, so a new bundle means a new server.
    watch(dirs.workerDir, requestRestart);
  };

  const launch = async (again: boolean): Promise<void> => {
    if (plan.mode === "dev") {
      if (!again) {
        opts.onState("installing", "installing the app's dependencies");
        await installManifest(pod, {
          manifest: `${PROJECT_ROOT}/package.json`,
          run,
          withDevDeps: true,
        });
      }
      const script = config.dev ?? "";
      const vite = /\bvite\b/u.test(script);
      const waiting = whenServerReady(pod, {
        port: vite ? port : null,
        signal: opts.signal,
      });
      opts.onState("starting", "running the app's dev script");
      await spawn(
        "npm",
        vite ? ["run", "dev", "--", "--port", String(port)] : ["run", "dev"]
      );
      await awaitReady(waiting);
      return;
    }
    if (plan.mode === "vite-build") {
      await launchBuild(again);
      return;
    }
    if (plan.mode === "worker") {
      await launchWorker(again);
      return;
    }
    if (!again) {
      await installTooling(pod, { srvx: SRVX_VERSION }, run);
    }
    const waiting = whenServerReady(pod, { port, signal: opts.signal });
    opts.onState("starting", "serving the assets");
    await writeHarness(pod.fs, {
      assets: absoluteAssets(config),
      bindings: [],
      entry: null,
      notFoundHandling: config.notFoundHandling,
      port,
    });
    await spawn("node", [HARNESS_SERVER]);
    await awaitReady(waiting);
  };

  /** Stop every process this preview started and give its port back. The pod
   * stays: only `stop()`'s caller owns the workspace, and it does not own it
   * either. */
  const halt = (): void => {
    if (debounce !== null) {
      window.clearTimeout(debounce);
      debounce = null;
    }
    for (const watcher of watchers.splice(0)) {
      watcher.close();
    }
    for (const child of processes.splice(0)) {
      try {
        child.kill();
      } catch {
        // Already gone: killing twice is not an error worth reporting.
      }
    }
    commands.clear();
    for (const registered of new Set([port, server.port])) {
      pod.proxy.unregister(pod.instanceId, registered);
    }
  };

  const restart = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    if (restarting) {
      queued = true;
      return;
    }
    restarting = true;
    try {
      opts.onLog(`preview: restarting (${plan.mode})`, "system");
      halt();
      await launch(true);
    } finally {
      restarting = false;
      if (queued && !stopped) {
        queued = false;
        requestRestart();
      }
    }
  };

  /** A restart a file event asked for: its failure is a state line, not an
   * unhandled rejection. */
  const restartOnChange = async (): Promise<void> => {
    try {
      await restart();
    } catch (error) {
      opts.onState(
        "error",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const scheduleRestart = (): void => {
    if (stopped || debounce !== null) {
      return;
    }
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- a debounce is a timer callback by definition
    debounce = window.setTimeout(() => {
      debounce = null;
      void restartOnChange();
    }, RESTART_DEBOUNCE_MS);
  };
  requestRestart = scheduleRestart;

  const stop = (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      halt();
    }
    return Promise.resolve();
  };

  // The listener is `once` and never removed: the signal belongs to this
  // preview, and `stop` is idempotent when the panel stops it first.
  opts.signal.addEventListener(
    "abort",
    () => {
      void stop();
    },
    { once: true }
  );
  opts.onLog(`preview: ${plan.mode} — ${plan.reason}`, "system");
  try {
    await launch(false);
  } catch (error) {
    await stop();
    throw error;
  }
  const handle: PreviewHandle = {
    processes: () => commands.lines(),
    restart,
    stop,
    get url(): string {
      return server.url;
    },
  };
  return handle;
};
