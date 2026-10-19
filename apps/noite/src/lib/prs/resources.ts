import { api } from "../api";
import { forgeKeys } from "../forge/data";
/** Pull-request data: resource keys and fetchers shared by the list, new and
 * detail views, with the same stale-while-revalidate contract as
 * `lib/resources` and `lib/forge/data`. */
import { invalidate, tracked as trackResource } from "../resource";
import type { Resource, ResourceFetcher } from "../resource";
import { keys } from "../resources";
import type { AppRole } from "../roles";
import type { PrDetail, PrList } from "../runner";
import type { PrStateFilter } from "./data";

/** Pull requests per list page (the runner caps `limit` at 100). */
export const PR_PAGE_SIZE = 30;

const tracked = <T>(key: string, fetcher: ResourceFetcher<T>): Resource<T> =>
  trackResource(key, fetcher);

export const prKeys = {
  detail: (appId: string, number: number) => `prs:detail:${appId}:${number}`,
  list: (appId: string, state: PrStateFilter, skip: number) =>
    `prs:list:${appId}:${state}:${skip}`,
  names: (appId: string, userIds: readonly string[]) =>
    `prs:names:${appId}:${[...userIds].toSorted().join(",")}`,
  viewer: (appId: string) => `prs:viewer:${appId}`,
} as const;

/** Every list key this document requested: a mutation drops them all without
 * knowing which filter/skip page is mounted. */
const listKeys = new Set<string>();

/** One page of pull requests plus the state counts. */
export const prList = (
  appId: string,
  state: PrStateFilter,
  skip = 0
): Resource<PrList> => {
  const key = prKeys.list(appId, state, skip);
  listKeys.add(key);

  return tracked(key, () =>
    api<PrList>("/api/prs/prsList", { appId, limit: PR_PAGE_SIZE, skip, state })
  );
};

/** One pull request with comments, reviews, compare and merge state. */
export const prDetail = (appId: string, number: number): Resource<PrDetail> =>
  tracked(prKeys.detail(appId, number), () =>
    api<PrDetail>("/api/prs/prsGet", { appId, number })
  );

/** Display names for a set of user ids (empty set short-circuits). */
export const prNames = (
  appId: string,
  userIds: readonly string[]
): Resource<Record<string, string>> =>
  tracked<Record<string, string>>(prKeys.names(appId, userIds), () =>
    userIds.length === 0
      ? Promise.resolve({})
      : api<Record<string, string>>("/api/prs/prsUserNames", {
          appId,
          userIds: [...userIds],
        })
  );

/** The signed-in viewer's id/name/role on this app. */
export interface PrViewer {
  id: string;
  name: string;
  role: AppRole;
}

export const prViewer = (appId: string) =>
  tracked(prKeys.viewer(appId), () =>
    api<PrViewer>("/api/prs/prsViewer", { appId })
  );

/** Drop the list pages and, alongside a PR's detail, refresh the branch
 * picker's tips and the environment box: a merge can delete the head branch
 * (and its preview environment) or move `main`. */
export const invalidatePr = (appId: string, number?: number): void => {
  if (number !== undefined) {
    invalidate(prKeys.detail(appId, number));
  }

  const prefix = `prs:list:${appId}:`;

  for (const key of listKeys) {
    if (key.startsWith(prefix)) {
      invalidate(key);
    }
  }

  invalidate(forgeKeys.refs(appId));
  invalidate(keys.environments(appId));
};
