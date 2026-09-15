/** Server-side client for the Rust runner. Browser never sees RUNNER_TOKEN. */
import { useEnv } from "oxidejs";

import { controlEnv, hydrateControlEnv } from "./control-env";

export interface RunnerApp {
  id: string;
  slug: string;
  name: string;
  userId: string;
  status: string;
  subdomain: string;
  gitPrefix: string;
  fleetBucket: string;
  listenPort: number | null;
  internalPort: number | null;
  lastDeploySha: string | null;
  lastError: string | null;
  desiredState: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerDeploy {
  id: string;
  appId: string;
  sha: string | null;
  status: string;
  log: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerGitRemote {
  remote: string;
  url: string;
  username: string;
  s3Remote: string;
  endpoint: string;
  bucket: string;
  prefix: string;
}

const alsEnv = (): KitEnv | undefined => {
  try {
    return useEnv<KitEnv>();
  } catch {
    return undefined;
  }
};

const readEnv = (): KitEnv => {
  hydrateControlEnv();
  const merged = {
    ...controlEnv,
    ...(typeof process === "undefined" ? undefined : process.env),
    ...alsEnv(),
  };
  // SAFETY: merged carries the union of controlEnv defaults, process.env, and the ALS env — all keyed by the same env names KitEnv declares; unset string keys are left undefined which callers already tolerate.
  return merged as KitEnv;
};

const runnerBase = () =>
  (
    readEnv().RUNNER_URL ??
    readEnv().HOST_URL ??
    readEnv().AGENT_URL ??
    "http://runner:8080"
  ).replace(/\/$/u, "");

const runnerToken = () => {
  const token =
    readEnv().RUNNER_TOKEN ??
    readEnv().HOST_TOKEN ??
    readEnv().AGENT_TOKEN ??
    "";
  if (!token) {
    throw new Error("RUNNER_TOKEN is not configured");
  }
  return token;
};

export const runnerFetch = async <T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${runnerToken()}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${runnerBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `runner ${init.method ?? "GET"} ${path}: ${res.status} ${text}`
    );
  }
  if (res.status === 204) {
    // SAFETY: 204 (no content) is only used by void/empty responses; callers type those `T`s as `void` or discard the value.
    // oxlint-disable-next-line typescript/no-invalid-void-type
    return undefined as T;
  }
  const payload = await res.json();
  // SAFETY: the runner returns the response object directly (no `{ body }` envelope); the JSON already matches the caller's requested `T`.
  return payload as T;
};

export const runnerListApps = () => runnerFetch<RunnerApp[]>("/v1/apps");

export const runnerCreateApp = (body: { name: string; slug: string }) =>
  runnerFetch<RunnerApp>("/v1/apps", {
    body: JSON.stringify(body),
    method: "POST",
  });

export const runnerGetApp = (id: string) =>
  runnerFetch<RunnerApp>(`/v1/apps/${id}`);

export const runnerPatchApp = (id: string, body: { desiredState: string }) =>
  runnerFetch<RunnerApp>(`/v1/apps/${id}`, {
    body: JSON.stringify(body),
    method: "PATCH",
  });

export const runnerDeleteApp = (id: string) =>
  // oxlint-disable-next-line typescript/no-invalid-void-type -- DELETE has no response body; void is the intended result type.
  runnerFetch<void>(`/v1/apps/${id}`, { method: "DELETE" });

export const runnerRenameApp = (
  id: string,
  body: { name?: string; slug?: string }
) =>
  runnerFetch<RunnerApp>(`/v1/apps/${id}/rename`, {
    body: JSON.stringify(body),
    method: "POST",
  });

export const runnerListDeploys = (id: string) =>
  runnerFetch<RunnerDeploy[]>(`/v1/apps/${id}/deploys`);

export const runnerGitRemote = (id: string) =>
  runnerFetch<RunnerGitRemote>(`/v1/apps/${id}/git-remote`, { method: "POST" });

export interface RunnerTree {
  sha: string;
  files: { path: string; size: number }[];
  truncated: boolean;
}

export interface RunnerBlob {
  sha: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  text: string;
}

export interface RunnerDiff {
  sha: string;
  parent: string | null;
  patch: string;
  truncated: boolean;
}

const encodePath = (path: string) =>
  path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

export const runnerSourceTree = (id: string) =>
  runnerFetch<RunnerTree>(`/v1/apps/${id}/tree`);

export const runnerSourceBlob = (id: string, path: string) =>
  runnerFetch<RunnerBlob>(`/v1/apps/${id}/blob/${encodePath(path)}`);

export const runnerSourceDiff = (id: string) =>
  runnerFetch<RunnerDiff>(`/v1/apps/${id}/diff`);

export interface RunnerMetric {
  appId: string;
  bucketTs: string;
  requests: number;
  errors: number;
  latencyMs: number;
  cpuMs: number;
}

export const runnerAppMetrics = (id: string, hours = 24) =>
  runnerFetch<RunnerMetric[]>(`/v1/apps/${id}/metrics?hours=${hours}`);

export interface RunnerSpan {
  name: string;
  kind: number;
  n: number;
  ms: number;
  err: number;
  qwaitMs: number;
}

export const runnerAppSpans = (id: string, hours = 1) =>
  runnerFetch<RunnerSpan[]>(`/v1/apps/${id}/spans?hours=${hours}`);

/** Most recent stdout/stderr lines from the running celld fleet. */
export const runnerAppLogs = (id: string) =>
  runnerFetch<string[]>(`/v1/apps/${id}/logs`);

export interface StorageItem {
  appId: string;
  appSlug: string;
  appName: string;
  // "d1" | "do" | "r2"
  kind: string;
  id: string;
  name: string;
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: string;
}

export interface R2Preview {
  appId: string;
  appSlug: string;
  bucket: string;
  objects: R2Object[];
}

export interface R2File {
  key: string;
  size: number;
  truncated: boolean;
  text: string | null;
}

export interface D1Preview {
  appId: string;
  appSlug: string;
  databaseId: string;
  tables: string[];
  rows: string[];
}

export interface DoPreview {
  appId: string;
  appSlug: string;
  className: string;
  instances: {
    id: string;
    scope: string;
    preview: string | null;
  }[];
}

/** D1 databases + DO classes declared by an app's deployed config. */
export const runnerStorage = (id: string) =>
  runnerFetch<StorageItem[]>(`/v1/apps/${id}/storage`);

/** Curated read-only D1 preview: tables + first rows. */
export const runnerD1 = (id: string, databaseId: string, rows = 20) =>
  runnerFetch<D1Preview>(
    `/v1/apps/${id}/storage/d1/${encodeURIComponent(databaseId)}?hours=${rows}`
  );

/** Read-only Durable Object instance list for one class. */
export const runnerDoInstances = (id: string, className: string) =>
  runnerFetch<DoPreview>(
    `/v1/apps/${id}/storage/do/${encodeURIComponent(className)}`
  );

/** Read-only R2 key listing for one bucket. */
export const runnerR2List = (id: string, bucket: string) =>
  runnerFetch<R2Preview>(
    `/v1/apps/${id}/storage/r2/${encodeURIComponent(bucket)}`
  );

/** Read-only R2 object fetch (bounded text preview, null when binary). */
export const runnerR2Get = (id: string, bucket: string, key: string) =>
  runnerFetch<R2File>(
    `/v1/apps/${id}/storage/r2/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`
  );

/** Delete one R2 object by key. */
export const runnerR2Delete = (id: string, bucket: string, key: string) =>
  runnerFetch<{ ok: boolean }>(
    `/v1/apps/${id}/storage/r2/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`,
    { method: "DELETE" }
  );

/** Browser download URL for one R2 object (UI proxy route — the browser
 * never sees RUNNER_TOKEN; the route gates on session + view role). */
export const r2DownloadUrl = (appId: string, bucket: string, key: string) =>
  `/storage/${encodeURIComponent(appId)}/r2/${encodeURIComponent(bucket)}/raw?key=${encodeURIComponent(key)}`;
