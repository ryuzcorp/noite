import { CodePage } from "$lib/forge/code-bar";
import { CommitView } from "$lib/forge/commit";
import { shortSha } from "$lib/forge/format";
import { searchParam } from "$lib/search-param";
import { head, useRoute } from "@ilha/router";

export default function CommitPage() {
  const { params } = useRoute();
  const { id: appId, sha } = params();
  // The ref and open file the commit was opened from; both are handed back to
  // the back link and to parent links, so the round trip returns to them.
  const gitRef = searchParam("ref", { default: "" });
  const file = searchParam("file", { default: "" });
  head({ title: `Commit ${sha ? shortSha(sha) : ""} · Noite` });
  if (!appId || !sha) {
    return <p class="text-error m-0 p-4 text-sm">Missing commit.</p>;
  }
  return (
    <CodePage appId={appId} backFile={file()} backRef={gitRef()}>
      <CommitView
        key={`${appId}:${sha}`}
        appId={appId}
        file={file()}
        gitRef={gitRef()}
        sha={sha}
      />
    </CodePage>
  );
}
