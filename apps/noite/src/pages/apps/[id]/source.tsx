import { ArrowLeft } from "$lib/icons";
import { appDetail } from "$lib/resources";
import { SourceBrowser } from "$lib/source-browser";
import type { SourceBrowserState, SourceMode } from "$lib/source-browser";
import { head, searchParam, useRoute } from "@ilha/router";
import { atom } from "ilha";
import type { AtomHandle } from "ilha";

/** Parse `?view=`: unknown views fall back to files. */
const toSourceMode = (raw: string): SourceMode =>
  raw === "diff" ? "diff" : "files";

/** Push button: the only reader of the browser's draft state. Keeping
 * that read out of SourceBody matters — every keystroke changes the dirty
 * count, and a SourceBody re-render detaches and re-attaches the reused
 * SourceBrowser subtree, which blurs the pierre editor mid-typing (ilha
 * restores focus via document.activeElement, i.e. only the shadow host). */
const PushButton = ({
  push,
  state,
}: {
  push: AtomHandle<number>;
  state: AtomHandle<SourceBrowserState>;
}) => {
  const { dirty, pushError, pushing } = state();
  let label = "Push";
  if (pushing) {
    label = "Pushing…";
  } else if (pushError) {
    label = "Push failed — retry";
  } else if (dirty > 0) {
    label = `Push (${dirty})`;
  }
  return (
    <button
      type="button"
      class="btn btn-sm btn-primary"
      disabled={dirty === 0 || pushing}
      onclick={() => {
        push.update((n) => n + 1);
      }}
    >
      {label}
    </button>
  );
};

const SourceBody = ({ appId }: { appId: string }) => {
  // View lives in ?view= so refresh and deep links restore it (back/forward
  // included — searchParam follows navigation). The browser watches the
  // mirrored mode atom (searchParam handles aren't watchable); the mirror
  // adopts the URL below.
  const view = searchParam<SourceMode>("view", {
    default: "files",
    parse: toSourceMode,
  });
  const mode = atom<SourceMode>(view());
  if (view() !== mode()) {
    mode.set(view());
  }
  const selectView = (next: SourceMode) => {
    view.set(next);
    mode.set(next);
  };
  // Open file lives in ?file= (deep-linkable); the browser reads + writes it.
  const file = searchParam("file", { default: "" });
  // Push requests: the button increments, the browser commits on change.
  const push = atom(0);
  const browser = atom<SourceBrowserState>({
    dirty: 0,
    pushError: false,
    pushing: false,
  });

  // Back-link label follows the app detail (instant from cache on SPA nav).
  const backName = appDetail(appId).data()?.app.name ?? "…";

  return (
    <div class="flex h-screen w-full flex-col overflow-hidden">
      <div class="border-base-300 flex items-center justify-between gap-2 border-b px-4 py-2">
        <a
          href={`/apps/${appId}`}
          class="link link-hover inline-flex w-fit items-center gap-1 text-sm opacity-70"
        >
          <ArrowLeft class="h-4 w-4" />
          <span>{backName}</span>
        </a>
        <div class="flex items-center gap-2">
          <div class="join">
            <button
              type="button"
              class={`btn btn-sm join-item ${mode() === "files" ? "btn-neutral" : "btn-ghost"}`}
              onclick={() => {
                selectView("files");
              }}
            >
              Files
            </button>
            <button
              type="button"
              class={`btn btn-sm join-item ${mode() === "diff" ? "btn-neutral" : "btn-ghost"}`}
              onclick={() => {
                selectView("diff");
              }}
            >
              Last push diff
            </button>
          </div>
          <PushButton push={push} state={browser} />
        </div>
      </div>
      <SourceBrowser
        appId={appId}
        file={file}
        mode={mode}
        onState={(s) => {
          browser.set(s);
        }}
        push={push}
      />
    </div>
  );
};

/** Source preview for one app — files of the latest pushed commit. The
 * body is keyed by app id so an id change remounts it (see the app page:
 * reused fibers keep resource()/feed slots bound to their first key). */
export default function Source() {
  const appId = useRoute().params().id;
  head({ title: "Source · Noite" });
  if (!appId) {
    return <p class="text-error">Missing app id</p>;
  }
  return <SourceBody key={appId} appId={appId} />;
}
