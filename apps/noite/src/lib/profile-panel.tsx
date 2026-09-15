import { atom, watch } from "ilha";

import { authClient, hardNav } from "./auth-client";

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: Date | string;
}

const formatCreated = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
};

/** Create / list / revoke Better Auth API keys (Git push password). */
export const ProfilePanel = () => {
  const ready = atom(false);
  const busy = atom(false);
  const error = atom("");
  const keys = atom<ApiKeyRow[]>([]);
  const freshKey = atom<string | null>(null);
  const name = atom("git");

  const reload = async () => {
    const result = await authClient.apiKey.list({
      query: { limit: 50, sortBy: "createdAt", sortDirection: "desc" },
    });
    if (result.error) {
      error.set(result.error.message ?? "Failed to list API keys");
      return;
    }
    keys.set(result.data?.apiKeys ?? []);
  };

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (!data?.user) {
        hardNav("/login");
        return;
      }
      await reload();
      ready.set(true);
    })();
  });

  const createKey = async (event: SubmitEvent) => {
    event.preventDefault();
    const label = name().trim();
    if (!label) {
      error.set("Name is required");
      return;
    }
    busy.set(true);
    error.set("");
    freshKey.set(null);
    const result = await authClient.apiKey.create({ name: label });
    busy.set(false);
    if (result.error) {
      error.set(result.error.message ?? "Failed to create API key");
      return;
    }
    const key = result.data?.key;
    if (key) {
      freshKey.set(key);
    }
    await reload();
  };

  const revoke = async (keyId: string) => {
    busy.set(true);
    error.set("");
    const result = await authClient.apiKey.delete({ keyId });
    busy.set(false);
    if (result.error) {
      error.set(result.error.message ?? "Failed to revoke API key");
      return;
    }
    if (freshKey()) {
      freshKey.set(null);
    }
    await reload();
  };

  if (!ready()) {
    return <p class="opacity-70">Loading…</p>;
  }

  return (
    <div class="flex flex-col gap-6">
      <section class="border-base-300 flex flex-col gap-3 rounded-lg border p-4">
        <h2 class="m-0 text-lg font-medium">API keys</h2>
        <p class="m-0 text-sm opacity-80">
          Use a key as the Git HTTPS password (<code>username=git</code>). Push
          requires collaborator <code>push</code> or <code>admin</code> on that
          app.
        </p>
        <form class="flex flex-wrap items-end gap-2" onsubmit={createKey}>
          <label class="form-control w-full max-w-xs">
            <span class="label-text text-xs">Name</span>
            <input
              class="input input-bordered input-sm"
              name="name"
              value={name()}
              oninput={(event) => {
                const target = event.currentTarget;
                if (target instanceof HTMLInputElement) {
                  name.set(target.value);
                }
              }}
              maxlength={32}
              required
            />
          </label>
          <button
            type="submit"
            class="btn btn-primary btn-sm"
            disabled={busy()}
          >
            Create key
          </button>
        </form>
        {freshKey() ? (
          <div class="bg-base-200 flex flex-col gap-1 rounded p-3 text-xs">
            <p class="m-0 font-medium">Copy now — shown once:</p>
            <code class="break-all">{freshKey()}</code>
          </div>
        ) : null}
        {error() ? <p class="text-error m-0 text-sm">{error()}</p> : null}
        {keys().length === 0 ? (
          <p class="m-0 text-sm opacity-70">No API keys yet.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {keys().map((row) => (
              <li
                key={row.id}
                class="border-base-300 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
              >
                <div class="flex flex-col gap-0.5">
                  <span class="font-medium">{row.name ?? "unnamed"}</span>
                  <span class="text-xs opacity-70">
                    {row.start ?? row.prefix ?? "••••"} ·{" "}
                    {formatCreated(row.createdAt)}
                    {row.enabled ? "" : " · disabled"}
                  </span>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  disabled={busy()}
                  onclick={() => {
                    void revoke(row.id);
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
