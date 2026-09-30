//! Shared async data: every resource key and fetcher in one module so
//! keys can't drift between components. All hooks wrap ilha's `resource()`
//! (deduped, abort signal) and paint the last good snapshot from
//! lib/swr-store until fresh data lands — across SPA remounts and reloads.
//! After a mutation call `invalidate(key)` or `res.refetch()`.
import { invalidate, resource } from "ilha";
import type { Resource, ResourceFetcher, ResourceOptions } from "ilha";

import {
  adminListInvites as fetchAdminInvites,
  listAllApps as fetchAllApps,
  listUsers as fetchUsers,
  adminOverview,
} from "./admin.server";
import {
  deployLog as fetchDeployLog,
  d1Preview as fetchD1Preview,
  doPreview as fetchDoPreview,
  get,
  listAppStorage,
  listCollaborators,
  listDomains,
  listEnv,
  listPendingInvitations,
  myCollaboratorInvitations,
  myInviteCodes,
  r2List as fetchR2List,
} from "./apps.server";
import { authClient } from "./auth-client";
import type { D1Preview, DoPreview, R2Preview } from "./runner";
import { clearSwrStore, withSnapshot, writeSwr } from "./swr-store";

export { invalidate } from "ilha";

/** Every key a hook has used this document. All cached data here is
 * user-scoped, so an auth change (sign-in, sign-out, impersonation) must
 * drop all of it — see `resetUserCaches`. */
const usedKeys = new Set<string>();

/** `resource()` with stale-while-revalidate across remounts *and* reloads:
 * `data` paints the last good snapshot (lib/swr-store) until the fresh
 * fetch lands, so panels skip skeletons whenever this key loaded before.
 * Each successful fetch writes the snapshot through. Consumers keep the
 * usual `loading() && data() === undefined` skeleton check — it now only
 * fires on a genuinely cold key. */
const tracked = <T>(
  key: string,
  fetcher: ResourceFetcher<T>,
  opts?: ResourceOptions
): Resource<T> => {
  usedKeys.add(key);
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

/** Drop every cached resource and snapshot, and refetch the live ones.
 * Call after any auth change: the layout stays mounted across navigation,
 * so nothing else would revalidate the session, admin status or per-user
 * data — and stored snapshots belong to the previous user. */
export const resetUserCaches = (): void => {
  clearSwrStore();
  for (const key of usedKeys) {
    invalidate(key);
  }
};

export const keys = {
  adminApps: "admin:apps",
  adminInvites: "admin:invites",
  adminOverview: "admin:overview",
  adminUsers: (query: string, page: number) => `admin:users:${page}:${query}`,
  apiKeys: "me:apikeys",
  appDetail: (id: string) => `app:${id}:detail`,
  appStorage: (id: string) => `app:${id}:storage`,
  collaborators: (id: string) => `app:${id}:collaborators`,
  d1Preview: (appId: string, databaseId: string) =>
    `app:${appId}:d1:${databaseId}`,
  deployLog: (appId: string, deployId: string) =>
    `app:${appId}:deploy:${deployId}:log`,
  doPreview: (appId: string, className: string) =>
    `app:${appId}:do:${className}`,
  domains: (id: string) => `app:${id}:domains`,
  envVars: (id: string) => `app:${id}:env`,
  inviteCodes: "me:invites",
  myInvitations: "me:collaborator-invitations",
  passkeys: "me:passkeys",
  pendingInvitations: (id: string) => `app:${id}:pending-invitations`,
  r2List: (appId: string, bucket: string) => `app:${appId}:r2:${bucket}`,
  session: "session",
  signupPolicy: "signup:policy",
} as const;

export const appDetail = (id: string) =>
  tracked(keys.appDetail(id), () => get(id));

export const appStorage = (id: string) =>
  tracked(keys.appStorage(id), () => listAppStorage({ appId: id }));

export const collaborators = (id: string) =>
  tracked(keys.collaborators(id), () => listCollaborators(id));

/** One finished deploy's build log, fetched when its tab opens and cached
 * per deploy id (finished deploys never change). */
export const deployLog = (appId: string, deployId: string) =>
  tracked(keys.deployLog(appId, deployId), () =>
    fetchDeployLog({ appId, deployId })
  );

/** Invitations waiting on one app. Admin-only server side, so other roles
 * get an empty list without a round trip. */
export const pendingInvitations = (id: string, isAdmin: boolean) =>
  tracked(keys.pendingInvitations(id), async () =>
    isAdmin ? await listPendingInvitations(id) : []
  );

/** Invitations addressed to the signed-in account. */
export const myInvitations = () =>
  tracked(keys.myInvitations, () => myCollaboratorInvitations());

export const domains = (id: string) =>
  tracked(keys.domains(id), () => listDomains(id));

export const envVars = (id: string) =>
  tracked(keys.envVars(id), () => listEnv(id));

/** What the UI renders from the session — and all it may persist. The
 * better-auth payload carries the session token (the httpOnly cookie's
 * secret); it must never reach the script-readable snapshot store. */
export interface SessionView {
  session: { impersonatedBy: string | null };
  user: { email: string; name: string };
}

export const session = () =>
  tracked(keys.session, async (): Promise<SessionView | null> => {
    const { data } = await authClient.getSession();
    if (!data) {
      return null;
    }
    // The admin plugin adds an optional impersonatedBy id to sessions it
    // creates; presence means this session is impersonated.
    // SAFETY: read-only probe of the plugin-added id (a user id string when
    // set); only its presence matters, and it is re-stringified below.
    const { impersonatedBy } = data.session as { impersonatedBy?: unknown };
    return {
      session: {
        impersonatedBy: impersonatedBy ? String(impersonatedBy) : null,
      },
      user: { email: data.user.email, name: data.user.name },
    };
  });

export const adminStatus = () =>
  tracked(keys.adminOverview, () => adminOverview());

export const inviteCodes = () =>
  tracked(keys.inviteCodes, () => myInviteCodes());

export const apiKeys = () =>
  tracked(keys.apiKeys, async () => {
    const result = await authClient.apiKey.list({
      query: { limit: 50, sortBy: "createdAt", sortDirection: "desc" },
    });
    if (result.error) {
      throw new Error(result.error.message ?? "Failed to list API keys");
    }
    return result.data?.apiKeys ?? [];
  });

/** What the account page shows for one registered passkey. */
export interface PasskeyView {
  backedUp: boolean;
  createdAt: string;
  deviceType: string;
  id: string;
  name: string;
}

export const passkeys = () =>
  tracked(keys.passkeys, async (): Promise<PasskeyView[]> => {
    const result = await authClient.passkey.listUserPasskeys();
    if (result.error) {
      throw new Error(result.error.message ?? "Failed to list passkeys");
    }
    return (result.data ?? []).map((row) => ({
      backedUp: Boolean(row.backedUp),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
      deviceType: row.deviceType,
      id: row.id,
      name: row.name ?? "",
    }));
  });

/** Public policy from `/api/invite/status` (first account bootstraps). */
export const signupPolicy = () =>
  tracked(keys.signupPolicy, async () => {
    try {
      const res = await fetch("/api/invite/status");
      if (res.ok) {
        // SAFETY: the route answers exactly this shape (see handleInviteStatus).
        return (await res.json()) as {
          firstRun: boolean;
          invitesPerUser: number;
          requiresInvite: boolean;
        };
      }
    } catch {
      // Fall through to the stricter default below.
    }
    return { firstRun: false, invitesPerUser: 0, requiresInvite: true };
  });

export const d1Preview = (appId: string, databaseId: string) =>
  tracked(keys.d1Preview(appId, databaseId), async () => {
    const preview = await fetchD1Preview({ appId, databaseId });
    // SAFETY: the d1Preview action unwraps to the runner's raw D1Preview
    // JSON at runtime; the Effect-union variant is only a typing edge.
    return (preview as D1Preview | null) ?? null;
  });

export const doPreview = (appId: string, className: string) =>
  tracked(keys.doPreview(appId, className), async () => {
    const preview = await fetchDoPreview({ appId, className });
    // SAFETY: same unwrap edge as d1Preview — raw DoPreview JSON at runtime.
    return (preview as DoPreview | null) ?? null;
  });

export const r2List = (appId: string, bucket: string) =>
  tracked(keys.r2List(appId, bucket), async () => {
    const preview = await fetchR2List({ appId, bucket });
    // SAFETY: same unwrap edge as d1Preview — raw R2Preview JSON at runtime.
    return (preview as R2Preview | null) ?? null;
  });

/** One page of the god-mode user list. The key carries the search and page,
 * so the caller mounts a fresh component per (query, page) — a resource key
 * cannot change under a mounted component. */
export const listUsers = (query: string, page: number) =>
  tracked(keys.adminUsers(query, page), () => fetchUsers({ page, query }));

export const listAllApps = () => tracked(keys.adminApps, () => fetchAllApps());

export const adminListInvites = () =>
  tracked(keys.adminInvites, () => fetchAdminInvites());
