import { api } from "./api";
import type {
  AdminAppRow,
  AdminUserRow,
  AppDetail,
  EnvironmentVarView,
  EnvVarView,
  InviteCode,
} from "./api-types";
import { authClient } from "./auth-client";
import type { CollaboratorRow, PendingInvite } from "./collaborators";
//! Shared async data: every resource key and fetcher in one module so
//! keys can't drift between components. All hooks wrap the shared Effect
//! Cache in lib/resource (deduped lookups, abort signal) and paint the last
//! good snapshot from lib/swr-store until fresh data lands — across SPA
//! remounts and reloads. After a mutation call `invalidate(key)` or
//! `res.refetch()`.
import {
  invalidate as invalidateKey,
  tracked as trackResource,
} from "./resource";
import type { Resource, ResourceFetcher } from "./resource";
import type {
  D1Rows,
  D1RowsQuery,
  D1Tables,
  D1TableSchema,
  DoPreview,
  R2File,
  R2Preview,
  RunnerDomain,
  RunnerEnvironment,
  RunnerErrorDetail,
  RunnerIngestKey,
  RunnerLimits,
  RunnerTelemetryStatus,
  RunnerUpdateStatus,
  StorageItem,
} from "./runner";
import { clearSwrStore } from "./swr-store";

export { invalidate } from "./resource";

/** Every key a hook has used this document. All cached data here is
 * user-scoped, so an auth change (sign-in, sign-out, impersonation) must
 * drop all of it — see `resetUserCaches`. */
const usedKeys = new Set<string>();

/** One mounted reader of `key` (lib/resource) with stale-while-revalidate
 * across remounts *and* reloads: `data` paints the last good snapshot
 * (lib/swr-store) until the fresh fetch lands, so panels skip skeletons
 * whenever this key loaded before. Each successful fetch writes the snapshot
 * through. Consumers keep the usual `loading() && data() === undefined`
 * skeleton check — it now only fires on a genuinely cold key. */
const tracked = <T>(
  key: string,
  fetcher: ResourceFetcher<T>,
  opts?: { persist?: boolean }
): Resource<T> => {
  usedKeys.add(key);

  return trackResource(key, fetcher, opts);
};

/** Drop every cached resource and snapshot, and refetch the live ones.
 * Call after any auth change: the layout stays mounted across navigation,
 * so nothing else would revalidate the session, admin status or per-user
 * data — and stored snapshots belong to the previous user. */
export const resetUserCaches = (): void => {
  clearSwrStore();

  for (const key of usedKeys) {
    invalidateKey(key);
  }
};

/** Canonical serialization of a rows query for the resource key: the same
 * query always maps to the same key (object property order is not part of the
 * query). */
const rowsQueryKey = (query: D1RowsQuery): string =>
  JSON.stringify([
    query.table,
    query.page,
    query.pageSize,
    query.sort ?? null,
    query.filters ?? [],
    query.search ?? "",
  ]);

/** Invalidate every cached D1 key of one database — the tables list, every
 * schema and every rows page, including the one currently rendered. A write
 * calls this so it does not need to know the exact page key of each mounted
 * view. */
export const invalidateD1 = (appId: string, databaseId: string): void => {
  const prefix = `app:${appId}:d1:${databaseId}:`;

  for (const key of usedKeys) {
    if (key.startsWith(prefix)) {
      invalidateKey(key);
    }
  }
};

/** Invalidate every cached R2 page of one bucket — every prefix and every
 * cursor — so an upload or delete refreshes whichever page is mounted. */
export const invalidateR2 = (appId: string, bucket: string): void => {
  const prefix = `app:${appId}:r2:${bucket}:`;

  for (const key of usedKeys) {
    if (key.startsWith(prefix)) {
      invalidateKey(key);
    }
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
  d1Rows: (appId: string, databaseId: string, query: D1RowsQuery) =>
    `app:${appId}:d1:${databaseId}:rows:${rowsQueryKey(query)}`,
  d1Schema: (appId: string, databaseId: string, table: string) =>
    `app:${appId}:d1:${databaseId}:schema:${table}`,
  d1Tables: (appId: string, databaseId: string) =>
    `app:${appId}:d1:${databaseId}:tables`,
  deployLog: (appId: string, deployId: string) =>
    `app:${appId}:deploy:${deployId}:log`,
  doPreview: (appId: string, className: string) =>
    `app:${appId}:do:${className}`,
  domains: (id: string) => `app:${id}:domains`,
  envVars: (id: string) => `app:${id}:env`,
  environmentVars: (appId: string, envId: string) =>
    `app:${appId}:environment:${envId}:vars`,
  environments: (id: string) => `app:${id}:environments`,
  errorDetail: (appId: string, fingerprint: string) =>
    `app:${appId}:error:${fingerprint}`,
  ingestKey: (id: string) => `app:${id}:ingest-key`,
  inviteCodes: "me:invites",
  limits: (id: string) => `app:${id}:limits`,
  myInvitations: "me:collaborator-invitations",
  passkeys: "me:passkeys",
  pendingInvitations: (id: string) => `app:${id}:pending-invitations`,
  r2File: (appId: string, bucket: string, key: string) =>
    `app:${appId}:r2:${bucket}:file:${key}`,
  r2List: (
    appId: string,
    bucket: string,
    prefix: string,
    cursor: string | null
  ) => `app:${appId}:r2:${bucket}:${prefix}:${cursor ?? ""}`,
  session: "session",
  signupPolicy: "signup:policy",
  telemetry: "admin:telemetry",
  update: "admin:update",
} as const;

export const appDetail = (id: string) =>
  tracked(keys.appDetail(id), () => api<AppDetail>("/api/apps/get", id));

export const appStorage = (id: string) =>
  tracked(keys.appStorage(id), () =>
    api<StorageItem[]>("/api/storage/listAppStorage", { appId: id })
  );

export const collaborators = (id: string) =>
  tracked(keys.collaborators(id), () =>
    api<CollaboratorRow[]>("/api/collaborators/listCollaborators", id)
  );

/** One finished deploy's build log, fetched when its tab opens and cached
 * per deploy id (finished deploys never change). 64 KB tails stay in memory
 * only: persisting them would crowd the small sessionStorage quota. */
export const deployLog = (appId: string, deployId: string) =>
  tracked(
    keys.deployLog(appId, deployId),
    () => api<{ log: string }>("/api/apps/deployLog", { appId, deployId }),
    { persist: false }
  );

/** Invitations waiting on one app. Admin-only server side, so other roles
 * get an empty list without a round trip. */
export const pendingInvitations = (id: string, isAdmin: boolean) =>
  tracked(keys.pendingInvitations(id), async () =>
    isAdmin
      ? await api<PendingInvite[]>(
          "/api/collaborators/listPendingInvitations",
          id
        )
      : []
  );

/** Invitations addressed to the signed-in account. */
export const myInvitations = () =>
  tracked(keys.myInvitations, () =>
    api<PendingInvite[]>("/api/collaborators/myCollaboratorInvitations", {})
  );

export const domains = (id: string) =>
  tracked(keys.domains(id), () =>
    api<RunnerDomain[]>("/api/domains/listDomains", id)
  );

export const limits = (id: string) =>
  tracked(keys.limits(id), () =>
    api<RunnerLimits>("/api/limits/getLimits", id)
  );

export const envVars = (id: string) =>
  tracked(keys.envVars(id), () => api<EnvVarView[]>("/api/env/listEnv", id));

/** Every preview environment of one app (view-gated server side). */
export const environments = (id: string) =>
  tracked(keys.environments(id), () =>
    api<RunnerEnvironment[]>("/api/environments/listEnvironments", id)
  );

/** Drop the cached environment rows of one app: a deploy created one, moved
 * one's tip or changed its status, and every reader of the list (the Preview
 * panel, the Deployments tab) must read them again. */
export const invalidateEnvironments = (id: string): void => {
  invalidateKey(keys.environments(id));
};

/** One environment's variable overrides, redacted (view-gated server side). */
export const environmentVars = (appId: string, envId: string) =>
  tracked(keys.environmentVars(appId, envId), () =>
    api<EnvironmentVarView[]>("/api/environments/environmentVars", {
      appId,
      envId,
    })
  );

/** One error with its latest occurrences. */
export const errorDetail = (appId: string, fingerprint: string) =>
  tracked(keys.errorDetail(appId, fingerprint), () =>
    api<RunnerErrorDetail>("/api/errors/errorDetail", { appId, fingerprint })
  );

/** This app's public error-ingest identity (project id + key) for the DSN. */
export const ingestKey = (id: string) =>
  tracked(keys.ingestKey(id), () =>
    api<RunnerIngestKey>("/api/errors/ingestKey", id)
  );

/** What the UI renders from the session — and all it may persist. The
 * better-auth payload carries the session token (the httpOnly cookie's
 * secret); it must never reach the script-readable snapshot store. */
export interface SessionView {
  session: { impersonatedBy: string | null };
  user: {
    email: string;
    /** The viewer's user id: the segment of their hidden preview refs
     * (`refs/previews/<id>/<branch>`), and what tells their own workspace
     * preview from another collaborator's. Never a secret — an environment's
     * host is minted from it. */
    id: string;
    name: string;
    /** Server-set first-run marker; null until `completeOnboarding`. */
    onboardedAt: string | null;
  };
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
    // SAFETY: onboardedAt is a better-auth additional field (`type: "date"`),
    // serialized over JSON as an ISO string or null; a SQLite-backed value
    // may also arrive as an epoch number, so stringify whatever is set.
    const { onboardedAt } = data.user as { onboardedAt?: unknown };

    return {
      session: {
        impersonatedBy: impersonatedBy ? String(impersonatedBy) : null,
      },
      user: {
        email: data.user.email,
        id: data.user.id,
        name: data.user.name,
        onboardedAt:
          onboardedAt === null || onboardedAt === undefined
            ? null
            : String(onboardedAt),
      },
    };
  });

/** What the admin shell gates on: the probe resolves instead of throwing,
 * so the panel renders for non-admins too. */
export interface AdminOverview {
  controlFleet: boolean;
  email: string;
  isAdmin: boolean;
}

export const adminStatus = () =>
  tracked(keys.adminOverview, () =>
    api<AdminOverview>("/api/admin/adminOverview", {})
  );

/** Anonymous instance telemetry state (admin-only server side). */
export const telemetry = () =>
  tracked(keys.telemetry, () =>
    api<RunnerTelemetryStatus>("/api/telemetry/getTelemetry", {})
  );

/** Opt-out update-check state (admin-only server side): the toggle, the
 * lock, the running version and the newest release seen. */
export const updateStatus = () =>
  tracked(keys.update, () =>
    api<RunnerUpdateStatus>("/api/update/getUpdateStatus", {})
  );

export const inviteCodes = () =>
  tracked(keys.inviteCodes, () =>
    api<InviteCode[]>("/api/account/myInviteCodes", {})
  );

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

/** Tables + row counts of one D1 database (left sidebar). */
export const d1Tables = (appId: string, databaseId: string) =>
  tracked(keys.d1Tables(appId, databaseId), () =>
    api<D1Tables>("/api/storage/d1Tables", { appId, databaseId })
  );

/** One table's schema (columns, indexes, caps, locked/redacted columns). */
export const d1Schema = (appId: string, databaseId: string, table: string) =>
  tracked(keys.d1Schema(appId, databaseId, table), () =>
    api<D1TableSchema>("/api/storage/d1Schema", { appId, databaseId, table })
  );

/** One server-side page of rows; the key carries the serialized query so a
 * mounted component only ever renders the query it was keyed with. */
export const d1Rows = (appId: string, databaseId: string, query: D1RowsQuery) =>
  tracked(keys.d1Rows(appId, databaseId, query), () =>
    api<D1Rows>("/api/storage/d1Rows", { appId, databaseId, ...query })
  );

export const doPreview = (appId: string, className: string) =>
  tracked(keys.doPreview(appId, className), () =>
    api<DoPreview>("/api/storage/doPreview", { appId, className })
  );

/** One page of an R2 bucket folder; the key carries prefix + cursor so a
 * mounted component only ever renders the page it was keyed with. */
export const r2List = (
  appId: string,
  bucket: string,
  prefix: string,
  cursor: string | null
) =>
  tracked(keys.r2List(appId, bucket, prefix, cursor), () =>
    api<R2Preview>("/api/storage/r2List", { appId, bucket, cursor, prefix })
  );

/** One object's bounded text preview (null `text` for a binary body).
 * Arbitrary file text stays in memory only: persisting it would crowd the
 * small sessionStorage quota. */
export const r2File = (appId: string, bucket: string, key: string) =>
  tracked(
    keys.r2File(appId, bucket, key),
    () => api<R2File>("/api/storage/r2Get", { appId, bucket, key }),
    { persist: false }
  );

/** One page of the admin home's user list. The key carries the search and
 * page, so the caller mounts a fresh component per (query, page) — a resource
 * key cannot change under a mounted component. */
export const listUsers = (query: string, page: number) =>
  tracked(keys.adminUsers(query, page), () =>
    api<{ hasMore: boolean; users: AdminUserRow[] }>("/api/admin/listUsers", {
      page,
      query,
    })
  );

export const listAllApps = () =>
  tracked(keys.adminApps, () =>
    api<AdminAppRow[]>("/api/admin/listAllApps", {})
  );

/** Every invitation code with both ends of the exchange (admin panel). */
export interface AdminInviteView {
  code: string;
  createdAt: string;
  createdByEmail: string;
  id: string;
  revoked: boolean;
  usedAt: string;
  usedByEmail: string;
}

export const adminListInvites = () =>
  tracked(keys.adminInvites, () =>
    api<AdminInviteView[]>("/api/admin/adminListInvites", {})
  );
