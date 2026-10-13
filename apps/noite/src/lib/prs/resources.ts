/** Pull-request data: resource keys and fetchers shared by the list, new and
 * detail views, with the same stale-while-revalidate contract as
 * `lib/resources` and `lib/forge/data`. */
import { invalidate, resource } from "ilha";
import type { Resource, ResourceFetcher, ResourceOptions } from "ilha";

import type { PrDetail, PrList } from "../runner";
import { prsGet, prsList, prsUserNames, prsViewer } from "../server/prs.server";
import { withSnapshot, writeSwr } from "../swr-store";
import type { PrStateFilter } from "./data";

/** Pull requests per list page (the runner caps `limit` at 100). */
export const PR_PAGE_SIZE = 30;

const tracked = <T>(
  key: string,
  fetcher: ResourceFetcher<T>,
  opts?: ResourceOptions
): Resource<T> => {
  const res = resource<T>(
    key,
    async (k, ctx) => {
      const value = await fetcher(k, ctx);
      writeSwr(k, value);
      return value;
    },
    opts
  );
  return { ...res, data: withSnapshot(key, res.data) };
};

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
    prsList({ appId, limit: PR_PAGE_SIZE, skip, state })
  );
};

/** One pull request with comments, reviews, compare and merge state. */
export const prDetail = (appId: string, number: number): Resource<PrDetail> =>
  tracked(prKeys.detail(appId, number), () => prsGet({ appId, number }));

/** Display names for a set of user ids (empty set short-circuits). */
export const prNames = (
  appId: string,
  userIds: readonly string[]
): Resource<Record<string, string>> =>
  tracked<Record<string, string>>(prKeys.names(appId, userIds), () =>
    userIds.length === 0
      ? Promise.resolve({})
      : prsUserNames({ appId, userIds: [...userIds] })
  );

/** The signed-in viewer's id/name/role on this app. */
export const prViewer = (appId: string) =>
  tracked(prKeys.viewer(appId), () => prsViewer({ appId }));

/** Drop a PR's detail and every list page after a mutation. */
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
};
