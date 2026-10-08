import { CodePage } from "$lib/forge/code-bar";
import { CommitView } from "$lib/forge/commit";
import { shortSha } from "$lib/forge/format";
import { head, useRoute } from "@ilha/router";

export default function CommitPage() {
  const { params } = useRoute();
  const { id: appId, sha } = params();
  head({ title: `Commit ${sha ? shortSha(sha) : ""} · Noite` });
  if (!appId || !sha) {
    return <p class="text-error m-0 p-4 text-sm">Missing commit.</p>;
  }
  return (
    <CodePage appId={appId}>
      <CommitView key={`${appId}:${sha}`} appId={appId} sha={sha} />
    </CodePage>
  );
}
