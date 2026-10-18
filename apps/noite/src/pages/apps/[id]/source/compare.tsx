import { CodePage } from "$lib/forge/code-bar";
import { CompareBar, CompareView } from "$lib/forge/compare";
import { head, useRoute } from "$lib/navigation";
import { searchParam } from "$lib/search-param";

export default function ComparePage() {
  const appId = useRoute().params().id;
  // Base defaults to the platform's default branch; head has no sensible
  // default, so the empty state just asks for one (the branch rows and the
  // source page link straight here with both set).
  const base = searchParam("base", { default: "main" });
  const headRef = searchParam("head", { default: "" });
  // The ref the compare was opened from (the branch picker sets it), so the
  // back link and the commit links return to that checkout.
  const gitRef = searchParam("ref", { default: "" });
  head({ title: `Compare ${base()}…${headRef()} · Noite` });
  if (!appId) {
    return <p class="text-error m-0 p-4 text-sm">Missing app id.</p>;
  }
  const pick = (nextBase: string, nextHead: string): void => {
    base.set(nextBase);
    headRef.set(nextHead);
  };
  return (
    <CodePage appId={appId} backRef={gitRef()}>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 class="m-0 text-xl font-semibold">Compare</h1>
        {headRef() === "" ? null : (
          <a
            class="btn btn-sm btn-neutral"
            href={`/apps/${appId}/pulls/new?base=${encodeURIComponent(base())}&head=${encodeURIComponent(headRef())}`}
          >
            Open pull request
          </a>
        )}
      </div>
      {headRef() === "" ? (
        <div class="flex flex-col gap-3">
          <CompareBar
            appId={appId}
            base={base()}
            head={headRef()}
            onPick={pick}
          />
          <p class="m-0 text-sm opacity-70">Choose a head ref to compare.</p>
        </div>
      ) : (
        <CompareView
          key={`${appId}:${base()}:${headRef()}`}
          appId={appId}
          base={base()}
          gitRef={gitRef()}
          head={headRef()}
          onPick={pick}
        />
      )}
    </CodePage>
  );
}
