/** The preview session's lifecycle over the frame's RPC: what a manual restart
 * that fails reports, what a session whose app's preview origin could not be
 * read does, what the frame's own events do to the panel's view, and what
 * happens to a URL that is not on the preview origin.
 *
 * The frame is a scripted RPC server on the other end of a real
 * `MessageChannel` pair — the same transport the page uses — so the session is
 * driven exactly as it is in the app, and every wait is a signal the session
 * itself produces. */

/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, typescript/no-invalid-void-type, unicorn/prefer-add-event-listener -- a test double for the port protocol: a message off a `MessagePort` is I/O (its fields are read and checked here), the scripted handlers are untyped by construction, a `void` resolution is a signal with no value, and `onmessage` is what starts the port (a listener would need an explicit `start()`). */
import { describe, expect, test } from "bun:test";

import { errorMessage } from "../errors";
import { bindPodPort } from "./pod-client";
import type { PodConnection } from "./pod-client";
import type { PodPreviewView } from "./pod-protocol";
import { createPreviewSession } from "./preview-session";
import type { PreviewSession } from "./preview-session";

const PREVIEW_ORIGIN = "https://app-0.preview.example";

/** The snapshot of a preview that is up on the app's own preview origin. */
const READY: PodPreviewView = {
  detail: "",
  error: "",
  logs: [],
  plan: null,
  processes: [],
  state: "ready",
  url: `${PREVIEW_ORIGIN}/__virtual__/app-1/5173/`,
};

/** A frame that answers the preview verbs a test scripted, over a real port. */
interface PreviewFrame {
  answer: (kind: string, handler: () => unknown) => void;
  emit: (kind: string, payload: unknown) => void;
  /** The kinds the frame was asked for, in order. */
  readonly requests: string[];
}

const newPreviewFrame = (port: MessagePort): PreviewFrame => {
  const requests: string[] = [];
  const answers = new Map<string, () => unknown>();
  port.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) {
      return;
    }
    const fields = new Map(Object.entries(data));
    const i = fields.get("i");
    const k = fields.get("k");
    if (typeof i !== "number" || typeof k !== "string") {
      return;
    }
    requests.push(k);
    const handler = answers.get(k);
    if (handler === undefined) {
      port.postMessage({ e: { message: `unhandled ${k}` }, i, ok: false });
      return;
    }
    void (async () => {
      try {
        port.postMessage({ i, ok: true, v: await handler() });
      } catch (error) {
        port.postMessage({ e: { message: errorMessage(error) }, i, ok: false });
      }
    })();
  };
  return {
    answer: (kind, handler) => {
      answers.set(kind, handler);
    },
    emit: (kind, payload) => {
      port.postMessage({ ev: kind, p: payload });
    },
    requests,
  };
};

/** A session attached to a scripted frame, and the frame it drives. */
const setup = (options: {
  /** The app's preview origin, as the page's own action answers it. */
  origin: string;
  script?: (frame: PreviewFrame) => void;
}): { frame: PreviewFrame; session: PreviewSession } => {
  const { port1, port2 } = new MessageChannel();
  const frame = newPreviewFrame(port2);
  options.script?.(frame);
  const connection: PodConnection = bindPodPort({
    dispose: () => {},
    onAsk: () => Promise.reject(new Error("the preview asks nothing")),
    port: port1,
  });
  const session = createPreviewSession({
    origin: () => Promise.resolve(options.origin),
  });
  session.attach(connection);
  return { frame, session };
};

describe("preview session", () => {
  test("a manual restart that fails drops the dead preview", async () => {
    const { session } = setup({
      origin: PREVIEW_ORIGIN,
      script: (frame) => {
        frame.answer("preview.open", () => READY);
        frame.answer("preview.restart", () => {
          throw new Error("restart: the server died");
        });
      },
    });

    await session.open();
    // The frame's own snapshot is what the panel draws.
    expect(session.view().url).toBe(READY.url);
    expect(session.view().state).toBe("ready");

    await session.restart();

    const view = session.view();
    // A restart that threw halted the server: a green "Ready" over the old URL
    // would lie about a preview that is not running.
    expect(view.state).toBe("error");
    expect(view.url).toBe("");
    expect(view.error).toBe("restart: the server died");
  });

  test("an origin that is not an origin starts nothing", async () => {
    const { frame, session } = setup({ origin: "" });

    await session.open();

    // An empty answer is what the control's preview-host action must never
    // give: it would leave every URL "on the origin" and mount the app on this
    // page's own. The session refuses before asking the frame for anything.
    expect(frame.requests).toEqual([]);
    const view = session.view();
    expect(view.state).toBe("error");
    expect(view.url).toBe("");
    expect(view.error).toContain("preview origin");
  });

  test("the frame's state and log events are what the panel draws", async () => {
    const { frame, session } = setup({
      origin: PREVIEW_ORIGIN,
      script: (scripted) => {
        scripted.answer("preview.open", () => READY);
      },
    });
    const logged = Promise.withResolvers<string>();
    session.onLog((line) => {
      logged.resolve(line.text);
    });
    const rebuilt = Promise.withResolvers<void>();
    session.subscribe(() => {
      if (session.view().state === "building") {
        rebuilt.resolve();
      }
    });
    await session.open();

    frame.emit("preview.log", { stream: "stdout", text: "vite v7" });
    expect(await logged.promise).toBe("vite v7");
    expect(session.view().logs).toEqual([
      { stream: "stdout", text: "vite v7" },
    ]);

    frame.emit("preview.state", {
      detail: "Building the app.",
      error: "",
      plan: null,
      processes: ["vite build"],
      state: "building",
      url: "",
    });
    await rebuilt.promise;
    expect(session.view().processes).toEqual(["vite build"]);
    expect(session.view().detail).toBe("Building the app.");
  });

  test("a preview URL off the app's own origin is refused", async () => {
    const { session } = setup({
      origin: PREVIEW_ORIGIN,
      script: (frame) => {
        frame.answer("preview.open", () => ({
          ...READY,
          url: "https://control.example/__virtual__/app-1/5173/",
        }));
      },
    });

    await session.open();

    const view = session.view();
    // Guest code must never run on this page's origin: the URL is dropped and
    // the panel says why.
    expect(view.url).toBe("");
    expect(view.state).toBe("error");
    expect(view.error).toContain("separate origin");
    expect(view.error).toContain(PREVIEW_ORIGIN);
  });
});
