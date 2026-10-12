//! The pod's virtual ports: pick one nothing answers on, and wait until the
//! process we just spawned answers on it. The pod announces a listening
//! server on the proxy's `server-ready` event, and `pod.port()` answers the
//! URL for a registered port — both are consulted, because a dev server may
//! pick a port of its own and a preview must not wait forever for the wrong
//! one.

import type { PreviewPod } from "./types";

/** A timer-based wait, the way `$lib/sleep` writes one — the pod's filesystem
 * and its proxy answer on the main thread, so polling is all this needs. */
const pause = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- a timer-based wait needs a fresh Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** How often a registered port is looked for, when no event arrives. */
const POLL_MS = 100;

/** How long a server may take to listen. A cold install of a Vite app in the
 * pod is seconds; a dev script that never listens must not hang the panel. */
export const READY_TIMEOUT_MS = 180_000;

/** How many ports past the preferred one a preview will look for. */
const PORT_SEARCH = 64;

export interface ReadyServer {
  port: number;
  url: string;
}

/** A port nothing answers on yet, starting at `preferred`. */
export const freePort = (pod: PreviewPod, preferred: number): number => {
  for (let port = preferred; port < preferred + PORT_SEARCH; port += 1) {
    if (pod.port(port) === null) {
      return port;
    }
  }
  return preferred;
};

/** Resolve once a server listens on `port` — or on any port, when the mode
 * cannot know one in advance (`null`, the dev-script case). */
export const whenServerReady = async (
  pod: PreviewPod,
  options: { port: number | null; signal: AbortSignal; timeoutMs?: number }
): Promise<ReadyServer> => {
  const wanted = options.port;
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let announced: ReadyServer | null = null;
  const onReady = (port: number, url: string, instanceId: string): void => {
    if (instanceId === pod.instanceId && (wanted === null || port === wanted)) {
      announced = { port, url: pod.port(port) ?? url };
    }
  };
  pod.proxy.on("server-ready", onReady);
  try {
    while (Date.now() < deadline) {
      if (options.signal.aborted) {
        throw new Error("preview: aborted");
      }
      if (announced !== null) {
        return announced;
      }
      if (wanted !== null) {
        const url = pod.port(wanted);
        if (url !== null) {
          return { port: wanted, url };
        }
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one look per tick, and the loop ends at the first port that answers
      await pause(POLL_MS);
    }
  } finally {
    pod.proxy.off("server-ready", onReady);
  }
  const seconds = Math.round(timeoutMs / 1000);
  throw new Error(
    wanted === null
      ? `preview: no server listened within ${seconds}s`
      : `preview: nothing listened on the pod's port ${wanted} within ${seconds}s`
  );
};

/** Wait until the pod holds a file. A build that writes its `index.html`
 * after a while is the client half of a `vite-build` preview being ready. */
export const whenFileExists = async (
  pod: PreviewPod,
  path: string,
  options: { signal: AbortSignal; timeoutMs?: number }
): Promise<void> => {
  const deadline = Date.now() + (options.timeoutMs ?? READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (options.signal.aborted) {
      throw new Error("preview: aborted");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- one check per tick; the loop ends when the build has written the file
    if (await pod.fs.exists(path)) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- the tick waits for the next look
    await pause(POLL_MS);
  }
  throw new Error(`preview: the build never wrote ${path}`);
};
