/** Shared resolution for every command's connection flags: the app slug, the
 * profile API key, the public git base and the control UI's origin. Each flag
 * falls back to its environment variable, exactly as the reference documents
 * them. */
import { Effect } from "effect";

/** Lowercase slug-safe. Mirrors the server's naming rule loosely; the
 * runner is the final arbiter (unknown slugs 404 at auth). */
export const sanitizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 63);

/** The app slug: `--slug`, then `NOITE_SLUG`, then the Actions repo name. */
export const resolveSlug = (flag: string, repo: string | null): string => {
  const direct = sanitizeSlug(
    flag === "" ? (process.env.NOITE_SLUG ?? "") : flag
  );
  if (direct !== "") {
    return direct;
  }
  if (repo === null) {
    return "";
  }
  return sanitizeSlug(repo.split("/")[1] ?? "");
};

/** Everything a platform command needs, resolved and validated. */
export interface Connection {
  readonly appUrl: string;
  readonly gitBase: string;
  readonly slug: string;
  readonly token: string;
}

/** The control UI's origin, derived from the git base — the one URL every
 * install documents: `<protocol>://git.<domain>` → `<protocol>://app.<domain>`,
 * and the bare base on a localhost install (the dev default; `.env.example`:
 * control is `http://noite.localhost:9080` locally, `https://app.noite.now` in
 * prod, because `CONTROL_SUBDOMAIN` is `app` there). `null` when the git base
 * is not a URL. */
const derivedAppUrl = (gitBase: string): string | null => {
  let url: URL;
  try {
    url = new URL(gitBase);
  } catch {
    return null;
  }
  const base = url.hostname.startsWith("git.")
    ? url.hostname.slice("git.".length)
    : url.hostname;
  const local =
    base === "localhost" ||
    base.endsWith(".localhost") ||
    base === "127.0.0.1" ||
    base === "[::1]";
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//${local ? base : `app.${base}`}${port}`;
};

/** Resolve the connection flags, or fail with the message the user needs.
 * `appUrl` is the origin every non-git command talks to (the account pages and
 * the MCP endpoint); `--app-url`/`NOITE_APP_URL` names it, else it is derived
 * from the git base. */
export const connection = (
  flags: {
    readonly appUrl?: string;
    readonly slug: string;
    readonly token: string;
    readonly url: string;
  },
  repo: string | null
): Effect.Effect<Connection, string, never> =>
  Effect.gen(function* run() {
    const slug = resolveSlug(flags.slug, repo);
    if (slug === "") {
      return yield* Effect.fail(
        "slug required: --slug, NOITE_SLUG, or GITHUB_REPOSITORY"
      );
    }
    const token =
      flags.token === ""
        ? (process.env.NOITE_API_KEY ?? process.env.NOITE_GIT_TOKEN ?? "")
        : flags.token;
    if (token === "") {
      return yield* Effect.fail(
        "API key required: --token, NOITE_API_KEY or NOITE_GIT_TOKEN (Account → API keys)"
      );
    }
    const gitBase = (
      flags.url === ""
        ? (process.env.GIT_PUBLIC_BASE ??
          process.env.NOITE_BASE ??
          "http://git.noite.localhost:9080")
        : flags.url
    ).replace(/\/+$/u, "");
    const named = (flags.appUrl ?? "") || (process.env.NOITE_APP_URL ?? "");
    const appUrl = named === "" ? derivedAppUrl(gitBase) : named;
    if (appUrl === null) {
      return yield* Effect.fail(`git base URL is malformed: ${gitBase}`);
    }
    return { appUrl: appUrl.replace(/\/+$/u, ""), gitBase, slug, token };
  });
