//! The Preview panel's vocabulary: what the runtime decides to run, what it
//! reports while it runs, and the slice of a pod it needs to do either. The
//! pod itself is `@r1ck404/nodepod`'s `Nodepod` — declared here structurally
//! (satisfied by `Nodepod`, and by nothing else in the app) so this directory
//! stays a module of plain interfaces, and so a test can hand in a double.

import type { WorkspaceFs } from "../workspace/types";

/** How a checkout is previewed. `dev` runs the app's own `dev` script;
 * `vite-build` builds the client and the Worker without the Cloudflare Vite
 * plugin; `worker` bundles the Worker entry with Vite (no plugins) and serves
 * that — the pod only strips the simplest TypeScript, so the entry is never
 * served raw; `static` serves an assets directory. */
export type PreviewMode = "dev" | "vite-build" | "worker" | "static";

/** What `planPreview` decided, and why — the start logs `reason` and the
 * panel shows every `notes` line, so a degraded preview is never silent. */
export interface PreviewPlan {
  mode: PreviewMode;
  /** One line: what was found and which mode that selects. */
  reason: string;
  /** What the preview cannot do here (Durable Objects, secrets, a missing
   * entry), one line each. */
  notes: string[];
}

/** Where the preview is in its lifecycle. `error` carries the message the
 * panel shows verbatim. */
export type PreviewState =
  | "installing"
  | "building"
  | "starting"
  | "ready"
  | "error";

/** One log line, already split: `system` is the runtime's own commentary
 * (installs, restarts), the other two are the process's output. */
export type PreviewLogStream = "stdout" | "stderr" | "system";

/** What the panel hands `startPreview`. The `signal` aborts the start: the
 * runtime stops every process it has spawned and rejects. */
export interface PreviewOptions {
  onLog: (line: string, stream: PreviewLogStream) => void;
  onState: (state: PreviewState, detail?: string) => void;
  signal: AbortSignal;
}

/** A running preview. `url` is the URL to put in the iframe — the pod's own
 * virtual-server URL, never the control UI's origin. */
export interface PreviewHandle {
  /** The live child processes' command lines, oldest first — what the
   * terminal's `preview` command shows. A line leaves when its child exits,
   * and `stop` clears what killing leaves behind. */
  processes: () => string[];
  /** Stop the processes this handle started (never the pod) and re-start
   * them, keeping whatever was installed. The URL stays the same. */
  restart: () => Promise<void>;
  stop: () => Promise<void>;
  url: string;
}

/** A spawned process, as Nodepod's `NodepodProcess` exposes it: `output` is
 * stdout, `error` is stderr, `exit` the exit code. */
export interface PreviewProcess {
  readonly completion: Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>;
  kill: () => void;
  /** `output` carries stdout, `error` stderr, `exit` the code. Three
   * overloads rather than one union: `NodepodProcess` declares exactly these,
   * and a single combined signature is not assignable to them. */
  on: {
    (event: "error", handler: (chunk: string) => void): void;
    (event: "exit", handler: (code: number) => void): void;
    // oxlint-disable-next-line typescript/unified-signatures -- the pod's class declares these three overloads; one combined signature would not accept it
    (event: "output", handler: (chunk: string) => void): void;
  };
}

/** How one spawn is configured — the subset of Nodepod's `SpawnOptions`. */
export interface PreviewSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** The installer flags the preview uses: progress for the log, and whether
 * the manifest's devDependencies come along. */
export interface PreviewInstallFlags {
  onProgress?: (message: string) => void;
  persist?: boolean;
  withDevDeps?: boolean;
}

/** What an install leaves behind: the packages it added, which is the part a
 * preview logs. */
export interface PreviewInstallOutcome {
  newPackages: string[];
}

/** The package installer, as `Nodepod.packages` exposes it. */
export interface PreviewPackages {
  install: (
    name: string,
    version?: string,
    flags?: PreviewInstallFlags
  ) => Promise<PreviewInstallOutcome>;
  installFromManifest: (
    manifestPath?: string,
    flags?: PreviewInstallFlags
  ) => Promise<PreviewInstallOutcome>;
  listInstalled: () => Record<string, string>;
}

/** The request proxy, as far as preview uses it: it announces every server
 * that starts listening, and it must be told when one goes away. */
export interface PreviewProxy {
  off: (
    event: "server-ready",
    handler: (port: number, url: string, instanceId: string) => void
  ) => void;
  on: (
    event: "server-ready",
    handler: (port: number, url: string, instanceId: string) => void
  ) => void;
  unregister: (instanceId: string, port: number) => void;
}

/** The pod the preview runs on — the slice of `Nodepod` this directory
 * touches. `startPreview` never tears a pod down: the pod is the workspace. */
export interface PreviewPod {
  fs: WorkspaceFs;
  instanceId: string;
  packages: PreviewPackages;
  /** The preview URL of a listening port, or null while nothing listens. */
  port: (port: number) => string | null;
  proxy: PreviewProxy;
  spawn: (
    cmd: string,
    args?: string[],
    opts?: PreviewSpawnOptions
  ) => Promise<PreviewProcess>;
}
