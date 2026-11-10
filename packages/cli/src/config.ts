/** Shared resolution for every command's connection flags: the app slug, the
 * profile API key, the public git base and the control UI's origin. Each flag
 * falls back to its environment variable, exactly as the reference documents
 * them.
 *
 * Connection resolution is one pure function (`resolveConnection`) over one
 * closed result type:
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Checking: flags + env + GITHUB_REPOSITORY
 *   Checking --> Refused: no slug / no key / malformed git base
 *   Checking --> Resolved: slug + token + control base
 * ```
 *
 * The control base is itself a closed union, so "local install", "prod
 * install" and "explicitly named origin" are observable instead of being
 * inferred from a hostname string at every call site. */
import { Data, Effect } from "effect";

/** Lowercase slug-safe. Mirrors the server's naming rule loosely; the
 * runner is the final arbiter (unknown slugs 404 at auth). */
export const sanitizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 63);

/** The app slug: `--slug`, then `NOITE_SLUG`, then the Actions repo name. */
export const resolveSlug = (
  flag: string,
  repo: string | null,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const direct = sanitizeSlug(flag === "" ? (env.NOITE_SLUG ?? "") : flag);

  if (direct !== "") {
    return direct;
  }

  if (repo === null) {
    return "";
  }

  return sanitizeSlug(repo.split("/")[1] ?? "");
};

/** Where the control UI lives, classified once. `Local` is the dev install
 * (control on the bare base host), `Prod` is the documented `app.<domain>`
 * shape, and `Custom` is an explicitly named `--app-url`/`NOITE_APP_URL`
 * origin. */
export type Base = Data.TaggedEnum<{
  Custom: { readonly origin: string };
  Local: { readonly origin: string };
  Prod: { readonly origin: string };
}>;

const { Custom, Local, Prod } = Data.taggedEnum<Base>();

/** Everything a platform command needs, resolved and validated. */
export interface Connection {
  readonly appUrl: string;
  readonly base: Base;
  readonly gitBase: string;
  readonly slug: string;
  readonly token: string;
}

/** Why a connection could not be resolved. The CLI prints these through
 * `connectionErrorMessage`, which keeps the wording stable. */
export type ConnectionError = Data.TaggedEnum<{
  MalformedBase: { readonly gitBase: string };
  MissingKey: Record<never, never>;
  MissingSlug: Record<never, never>;
}>;

const { MalformedBase, MissingKey, MissingSlug } =
  Data.taggedEnum<ConnectionError>();

/** Exactly one message per refusal: the user-facing string every command has
 * always printed. */
export const connectionErrorMessage = (error: ConnectionError): string => {
  switch (error._tag) {
    case "MalformedBase": {
      return `git base URL is malformed: ${error.gitBase}`;
    }

    case "MissingKey": {
      return "API key required: --token, NOITE_API_KEY or NOITE_GIT_TOKEN (Account → API keys)";
    }

    case "MissingSlug": {
      return "slug required: --slug, NOITE_SLUG, or GITHUB_REPOSITORY";
    }

    default: {
      const unhandled: never = error;

      return unhandled;
    }
  }
};

/** The control origin, derived from the git base — the one URL every install
 * documents: `<protocol>://git.<domain>` → `<protocol>://app.<domain>`, and
 * the bare base on a localhost install (the dev default; `.env.example`:
 * control is `http://noite.localhost:9080` locally, `https://app.noite.now` in
 * prod, because `CONTROL_SUBDOMAIN` is `app` there). An explicit origin wins.
 * `null` when the git base is not a URL and no origin was named. */
export const controlBase = (gitBase: string, named: string): Base | null => {
  if (named !== "") {
    return Custom({ origin: named.replace(/\/+$/u, "") });
  }

  let url: URL;

  try {
    url = new URL(gitBase);
  } catch {
    return null;
  }

  const host = url.hostname.startsWith("git.")
    ? url.hostname.slice("git.".length)
    : url.hostname;

  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]";

  const origin = `${url.protocol}//${local ? host : `app.${host}`}${
    url.port === "" ? "" : `:${url.port}`
  }`;

  return local ? Local({ origin }) : Prod({ origin });
};

/** The resolved-or-refused outcome of one connection attempt. */
export type Resolution = Data.TaggedEnum<{
  Refused: { readonly error: ConnectionError };
  Resolved: { readonly connection: Connection };
}>;

const { Refused, Resolved } = Data.taggedEnum<Resolution>();

/** Resolve every flag in one place: slug, then token, then the git base and
 * its control origin. Order is the refusal precedence the CLI documents. */
export const resolveConnection = (
  flags: {
    readonly appUrl?: string;
    readonly slug: string;
    readonly token: string;
    readonly url: string;
  },
  repo: string | null,
  env: NodeJS.ProcessEnv = process.env
): Resolution => {
  const slug = resolveSlug(flags.slug, repo, env);

  if (slug === "") {
    return Refused({ error: MissingSlug() });
  }

  const token =
    flags.token === ""
      ? (env.NOITE_API_KEY ?? env.NOITE_GIT_TOKEN ?? "")
      : flags.token;

  if (token === "") {
    return Refused({ error: MissingKey() });
  }

  const gitBase = (
    flags.url === ""
      ? (env.GIT_PUBLIC_BASE ??
        env.NOITE_BASE ??
        "http://git.noite.localhost:9080")
      : flags.url
  ).replace(/\/+$/u, "");

  const named = (flags.appUrl ?? "") || (env.NOITE_APP_URL ?? "");
  const base = controlBase(gitBase, named);

  if (base === null) {
    return Refused({
      error: MalformedBase({ gitBase }),
    });
  }

  return Resolved({
    connection: { appUrl: base.origin, base, gitBase, slug, token },
  });
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
    const resolution = resolveConnection(flags, repo);

    if (resolution._tag === "Refused") {
      return yield* Effect.fail(connectionErrorMessage(resolution.error));
    }

    return resolution.connection;
  });
