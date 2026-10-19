import { api } from "../api";
import type { GitLogInput } from "../api-types";
/**
 * Forge data: the resource keys and fetchers the forge pages share, so a
 * key can never drift between the branch picker, history, commit and compare
 * views. Same stale-while-revalidate contract as `lib/resources` (last good
 * snapshot paints until the fresh fetch lands).
 */
import { invalidate, tracked as trackResource } from "../resource";
import type { Resource, ResourceFetcher } from "../resource";
import type { GitCommitDetail, GitCompare, GitLog, GitRefs } from "../runner";

/** Commits per history page (the runner caps `limit` at 100). */
export const LOG_PAGE_SIZE = 50;

const tracked = <T>(key: string, fetcher: ResourceFetcher<T>): Resource<T> =>
  trackResource(key, fetcher);

export const forgeKeys = {
  commit: (appId: string, sha: string) => `forge:commit:${appId}:${sha}`,
  compare: (appId: string, base: string, head: string) =>
    `forge:compare:${appId}:${base}:${head}`,
  log: (appId: string, ref: string, path: string, skip: number) =>
    `forge:log:${appId}:${ref}:${path}:${skip}`,
  refs: (appId: string) => `forge:refs:${appId}`,
} as const;

/** Branches with their tip, last commit and ahead/behind vs main. */
export const forgeRefs = (appId: string): Resource<GitRefs> =>
  tracked(forgeKeys.refs(appId), () =>
    api<GitRefs>("/api/forge/gitRefs", { appId })
  );

/** Every history page this document has requested: a branch mutation drops
 * them all without knowing which page is mounted. */
const logKeys = new Set<string>();

/** One page of a ref's history, optionally scoped to one path. */
export const forgeLog = (
  appId: string,
  ref: string,
  path: string,
  skip: number
): Resource<GitLog> => {
  const key = forgeKeys.log(appId, ref, path, skip);
  logKeys.add(key);

  return tracked(key, () => {
    // Absent, never `undefined`: the action encoder refuses non-JSON values.
    const args: GitLogInput = { appId, limit: LOG_PAGE_SIZE, skip };

    if (path !== "") {
      args.path = path;
    }

    if (ref !== "") {
      args.ref = ref;
    }

    return api<GitLog>("/api/forge/gitLog", args);
  });
};

/** One commit with its first-parent diff. */
export const forgeCommit = (appId: string, sha: string) =>
  tracked(forgeKeys.commit(appId, sha), () =>
    api<GitCommitDetail>("/api/forge/gitCommit", { appId, sha })
  );

/** Three-dot compare of two refs plus the squash-merge verdict. */
export const forgeCompare = (appId: string, base: string, head: string) =>
  tracked(forgeKeys.compare(appId, base, head), () =>
    api<GitCompare>("/api/forge/gitCompare", { appId, base, head })
  );

/** Refetch the branch list and every history page after a branch create or
 * delete. */
export const invalidateForge = (appId: string): void => {
  invalidate(forgeKeys.refs(appId));
  const prefix = `forge:log:${appId}:`;

  for (const key of logKeys) {
    if (key.startsWith(prefix)) {
      invalidate(key);
    }
  }
};
