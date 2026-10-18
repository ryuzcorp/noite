/**
 * Wire DTOs for the Void JSON-action endpoints (`POST /api/<module>/<action>`):
 * the one client-safe home for the shapes both sides agree on. Server action
 * modules annotate their outputs with these (so drift fails `tsc` server
 * side); client fetchers name them in `api<T>` calls. Type-only: nothing here
 * may gain a runtime import — server modules and browser code both import
 * this module.
 */
import type { AppRole } from "./roles";
import type { RunnerApp } from "./runner";

/** What the create form shows under its Slug field while you type. */
export interface SlugCheck {
  /** Why the slug cannot be used, or null when it is free. */
  error: string | null;
  /** The git remote it would get; empty when the instance has no public git
   * base configured. */
  gitRemote: string;
  /** `<slug>.<BASE_DOMAIN>`: the host the app is served on. */
  host: string;
  /** A free variant to offer when the slug is taken. */
  suggestion: string | null;
}

/** One env row as the browser sees it. Values are write-only: only
 * `FLAG_*` toggles (non-secret `1`/`0` by convention) carry theirs, so a
 * view-only collaborator — or anything persisted client-side — never holds a
 * secret. */
export interface EnvVarView {
  name: string;
  updatedAt: string;
  value: string;
}

/** One environment variable override as the browser sees it (same
 * write-only rule as `EnvVarView`). */
export type EnvironmentVarView = EnvVarView;

/** One account row on the admin home's Users tab. */
export interface AdminUserRow {
  banned: boolean;
  createdAt: string;
  email: string;
  id: string;
  name: string;
  role: string;
}

/** One app row on the admin home's Apps tab. */
export interface AdminAppRow {
  desiredState: string;
  id: string;
  name: string;
  ownerEmail: string;
  ownerId: string;
  slug: string;
  status: string;
}

/** One app with what its Overview needs: the row, the caller's role, and
 * the git/serve addresses derived from it. */
export interface AppDetail {
  app: RunnerApp;
  gitHint: string;
  gitRemote: string;
  host: string;
  myRole: AppRole;
  s3Endpoint: string;
  username: string;
}

/** What `gitLog` takes; optional fields are omitted, never `undefined`. */
export interface GitLogInput {
  appId: string;
  limit?: number;
  path?: string;
  ref?: string;
  skip?: number;
}

/** What `prsCreate` takes; optional fields are omitted, never `undefined`. */
export interface PrCreateInput {
  appId: string;
  base: string;
  body?: string;
  head: string;
  title: string;
}

/** What `prsMerge` takes; optional fields are omitted, never `undefined`. */
export interface PrMergeInput {
  appId: string;
  deleteBranch?: boolean;
  message?: string;
  number: number;
  title?: string;
}

/** A profile invite code the account can hand out. */
export interface InviteCode {
  code: string;
  id: string;
}
