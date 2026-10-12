/** Code mode's Preview panel: the app running for real, in an iframe served by
 * the pod's own service worker. The frame is on a different origin from this
 * page — the edge's per-app preview host — which is what keeps the app inside
 * it from reaching this page's storage or acting as its viewer. */
import { atom, watch } from "ilha";

import { Info, Refresh } from "../ui/icons";
import type { PreviewSession, PreviewView } from "./preview-session";
import { previewAddress } from "./preview/address";

/** Where the address bar sent the frame, and the preview URL it was typed
 * against: a new preview (a restart, another start) drops it. `visit` makes
 * Enter on the same address load it again. */
interface Navigation {
  base: string;
  src: string;
  visit: number;
}

/** What each state of the preview is called (the status dot's accessible name
 * and tooltip) and the dot's daisyUI tone: green when the app answers,
 * yellow (pulsing) while a start is on its way, red when it failed, grey
 * before anything runs. */
const STATUS: Record<PreviewView["state"], { label: string; tone: string }> = {
  building: { label: "Building", tone: "status-warning animate-pulse" },
  error: { label: "Failed", tone: "status-error" },
  idle: { label: "Idle", tone: "status-neutral" },
  installing: { label: "Installing", tone: "status-warning animate-pulse" },
  ready: { label: "Ready", tone: "status-success" },
  starting: { label: "Starting", tone: "status-warning animate-pulse" },
};

/** What the frame shows until the preview has a URL to load. */
const WAITING_LABEL: Record<PreviewView["state"], string> = {
  building: "Building the app…",
  error: "The preview failed to start.",
  idle: "Waiting for the checkout…",
  installing: "Installing the app's dependencies…",
  ready: "The server answered; loading the app.",
  starting: "Starting the app's server…",
};

/** What the frame shows until the preview has a URL to load: a stopped
 * preview (idle with output behind it) names itself, every other state reads
 * off the table. */
const waitingText = (view: PreviewView): string =>
  view.state === "idle" && view.logs.length > 0
    ? "Stopped. Restart to run it again."
    : WAITING_LABEL[view.state];

/** The states in which a start is already in flight: Restart waits for them to
 * settle rather than racing a second start into the same pod. */
const IN_FLIGHT: ReadonlySet<PreviewView["state"]> = new Set([
  "building",
  "installing",
  "starting",
]);

export interface PreviewPanelProps {
  session: PreviewSession;
}

export const PreviewPanel = ({ session }: PreviewPanelProps) => {
  const view = atom<PreviewView>(session.view());
  watch.once(({ onCleanup }) => {
    const unsubscribe = session.subscribe(() => {
      view.set(session.view());
    });
    void session.open();
    onCleanup(() => {
      unsubscribe();
      // Closing the panel stops the preview: what the user put away must not
      // keep a server and its build watcher running. Switching tabs does not
      // reach here — the panel keeps every tab it has shown mounted — so the
      // frame and the server survive a switch. Reopening after a close starts
      // it again, cheap through the pod's IndexedDB package cache.
      void session.close();
    });
  });
  const current = view();
  const navigated = atom<Navigation | null>(null);
  /** The address bar's text while it is being edited; null shows the frame's. */
  const draft = atom<string | null>(null);
  const refused = atom(false);
  const navigation = navigated();
  const followed = navigation !== null && navigation.base === current.url;
  const src = followed ? navigation.src : current.url;
  const visit = followed ? navigation.visit : 0;
  const go = () => {
    const next = previewAddress(draft() ?? src, current.url);
    if (next === null) {
      refused.set(true);
      return;
    }
    navigated.set({ base: current.url, src: next, visit: visit + 1 });
    draft.set(null);
    refused.set(false);
  };
  // A failed start has a message of its own; an error the runtime reported has
  // only its detail, and the status line truncates. Either way the panel shows
  // it whole, verbatim.
  let failure = current.error;
  if (failure === "" && current.state === "error") {
    failure = current.detail;
  }
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="border-base-300 flex items-center gap-1 border-b px-2 py-1.5">
        <form
          class="min-w-0 flex-1"
          onsubmit={(event) => {
            event.preventDefault();
            go();
          }}
        >
          <label
            class={`input input-sm w-full gap-2 font-mono text-xs${refused() ? " input-error" : ""}`}
            title={
              refused() ? "Only this preview's own host can be opened" : src
            }
          >
            <span
              class={`status shrink-0 ${STATUS[current.state].tone}`}
              role="status"
              aria-label={STATUS[current.state].label}
              title={STATUS[current.state].label}
            ></span>
            <input
              type="text"
              class="min-w-0 grow"
              aria-label="Preview address"
              aria-invalid={refused() ? "true" : undefined}
              placeholder={STATUS[current.state].label}
              readonly={current.url === ""}
              spellcheck={false}
              value={draft() ?? src}
              oninput={(event) => {
                draft.set(event.currentTarget.value);
                refused.set(false);
              }}
              onkeydown={(event) => {
                if (event.key === "Escape") {
                  draft.set(null);
                  refused.set(false);
                }
              }}
            />
          </label>
        </form>
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-square shrink-0"
          aria-label="Restart preview"
          title="Restart preview"
          disabled={IN_FLIGHT.has(current.state)}
          onclick={() => {
            void session.restart();
          }}
        >
          <Refresh
            class={`h-4 w-4${IN_FLIGHT.has(current.state) ? " animate-spin" : ""}`}
          />
        </button>
      </div>
      {failure === "" ? null : (
        <p
          class="bg-error/10 text-error border-base-300 m-0 border-b px-3 py-2 text-xs break-words whitespace-pre-wrap"
          role="alert"
        >
          {failure}
        </p>
      )}
      <div class="bg-base-300/40 relative min-h-0 flex-1">
        {current.url === "" ? (
          <p class="absolute inset-0 m-0 flex items-center justify-center p-4 text-center text-xs opacity-70">
            {waitingText(current)}
          </p>
        ) : (
          // No `sandbox` attribute: the preview *is* a service worker
          // registered on the preview origin, and a sandboxed frame is an
          // opaque origin that can never register one. Nothing is lost by its
          // absence — the frame is on the app's own origin, never this page's,
          // so the app inside cannot read this page's storage or post to the
          // control UI as the viewer.
          //
          // The frame inherits this page's `color-scheme`, which is what the
          // app inside sees as `prefers-color-scheme`; an app that declares
          // no scheme of its own still gets the browser's light backdrop. So
          // the frame's own background is the theme's, never a fixed white
          // that would sit under a dark app's light text.
          <iframe
            key={`${src}#${visit}`}
            title="App preview"
            class="bg-base-100 absolute inset-0 h-full w-full border-0"
            src={src}
          />
        )}
      </div>
    </div>
  );
};

/** What the panel says about every preview, whatever it runs. */
const PREVIEW_ABOUT =
  "One preview runs per app at a time: the app's servers all answer on its own preview host. Switching to another tab leaves it running; closing this panel stops its preview, and Restart replaces it.";

/** The info icon beside the panel's title: the plan's notes (bindings run
 * locally, …) and how a preview runs, as a tooltip rather than lines that
 * take the frame's room. */
export const PreviewInfo = ({ session }: PreviewPanelProps) => {
  const notes = atom<readonly string[]>(session.view().plan?.notes ?? []);
  watch.once(({ onCleanup }) => {
    onCleanup(
      session.subscribe(() => {
        notes.set(session.view().plan?.notes ?? []);
      })
    );
  });
  const tip = [...notes(), PREVIEW_ABOUT].join("\n\n");
  return (
    <span
      class="tooltip tooltip-bottom relative z-40 inline-flex before:text-left before:whitespace-pre-line"
      data-tip={tip}
      aria-label={tip}
      role="img"
      tabindex={0}
    >
      <Info class="h-3.5 w-3.5 opacity-60" />
    </span>
  );
};
