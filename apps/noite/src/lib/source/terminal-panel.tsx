/** Code mode's Terminal panel: the workspace's own shell below the editor.
 * The shell itself lives in the session (it survives this panel unmounting);
 * this component is the header and the shadow-pane mount point. Like the
 * source panes, the mount point is a shadow root — ilha's morph rewrites a
 * host's light DOM on every re-render, and shadow content is invisible to it
 * (see `./pane`). */

import { atom, watch } from "ilha";

import { collectRef, newLiveRef, whenLive } from "../live-ref";
import { X } from "../ui/icons";
import { MORPH_PRESERVE } from "../ui/resizable";
import type { TerminalSession } from "./terminal-session";

/** Styles inside the terminal's shadow root: fill the host (a flex-1 body)
 * and stretch the session's div so ghostty measures a real box. */
const TERMINAL_CSS = `
:host { display: block; height: 100%; }
.term-body { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.term-body > div { flex: 1; min-height: 0; min-width: 0; }
`;

/** The mount point the session moves its shell into, inside a shadow root on
 * `host` (created once — re-renders resolve the same pane). */
const shadowPane = (host: HTMLElement): HTMLElement => {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const existing = root.querySelector<HTMLElement>(".term-body");

  if (existing) {
    return existing;
  }

  const style = document.createElement("style");
  style.textContent = TERMINAL_CSS;
  const pane = document.createElement("div");
  pane.className = "term-body";
  root.append(style, pane);

  return pane;
};

export const TerminalPanel = ({
  defaultSize,
  onClose,
  terminal,
}: {
  /** The share of the group the pane opens at (`data-default-size`, in
   * percent) — the split the user last dragged it to, or nothing for the
   * page's own third. */
  defaultSize?: number;
  terminal: TerminalSession;
  onClose: () => void;
}) => {
  const terminalView = atom(terminal.view());
  const body = atom.lazy(() => newLiveRef<HTMLDivElement>())();
  watch.once(({ onCleanup, signal }) => {
    const stopTerminal = terminal.subscribe(() => {
      terminalView.set(terminal.view());
    });

    // The ref fires before insertion: wait for the host that is really in
    // the document, never a scratch copy the morph is about to discard. The
    // wait repeats while mounted: on a slow first paint the bounded wait can
    // give up before insertion, and a mount that never runs leaves the body
    // empty with no error and nothing retrying it.
    void (async () => {
      while (!signal.aborted) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one host lookup per pass; the loop ends at the first connected host
        const el = await whenLive(body, signal);

        if (signal.aborted || el === null) {
          continue;
        }

        // Mount never rejects (the session reports readiness through its
        // view), so this is fired and the loop ends on the first live host.
        void terminal.mount(shadowPane(el));

        return;
      }
    })();

    onCleanup(() => {
      stopTerminal();
      terminal.unmount();
    });
  });
  const current = terminalView();

  return (
    // The pane itself: the page's own resizable group owns the rows and the
    // split (see $lib/ui/resizable); below `lg` this root only fills its own
    // third of the column.
    <section
      aria-label="Terminal"
      data-slot="resizable-panel"
      data-default-size={defaultSize}
      data-morph-preserve={MORPH_PRESERVE}
      class="border-base-300 bg-base-100 flex min-h-0 min-w-0 shrink-0 grow-0 basis-1/3 flex-col overflow-hidden border-t"
    >
      <div class="border-base-300 flex min-h-9 items-center gap-2 border-b py-1 pr-1.5 pl-3">
        <h2 class="m-0 text-sm font-semibold">Terminal</h2>
        <span class="ml-auto flex items-center">
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square opacity-70 hover:opacity-100"
            aria-label="Close panel"
            title="Close panel"
            onclick={onClose}
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {current.error === "" ? null : (
        <p
          class="bg-error/10 text-error border-base-300 m-0 border-b px-3 py-2 text-xs break-words whitespace-pre-wrap"
          role="alert"
        >
          {current.error}
        </p>
      )}
      <div
        ref={(el) => {
          collectRef(body, el);
        }}
        class="min-h-0 flex-1"
      ></div>
    </section>
  );
};
