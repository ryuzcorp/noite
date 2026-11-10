/**
 * The proxy's route table: one `matchRoute` decides every request before any
 * body is read or authenticated.
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> Health: GET /health
 *     [*] --> MethodNotAllowed: /health with another method
 *     [*] --> NotFound: path not in the table
 *     [*] --> MethodNotAllowed: table path, method != POST
 *     [*] --> Removed: POST /email/relay (tombstone)
 *     [*] --> Revalidate: POST /revalidate
 *     [*] --> EmailSend: POST /email/send
 *     [*] --> AiProvider: POST /ai/provider
 *     [*] --> AiRun: POST /ai/run
 *     [*] --> AiUnavailable: POST /ai/models | /ai/toMarkdown
 * ```
 *
 * `Removed` is a tombstone, not a handler: it answers 404 before
 * authentication so an untrusted relay payload is never parsed. Every other
 * path under `/email/` is outside the table, so it answers 404 before
 * authentication too.
 */

export type ProxyRoute =
  | { readonly _tag: "AiProvider" }
  | { readonly _tag: "AiRun" }
  | { readonly _tag: "AiUnavailable" }
  | { readonly _tag: "EmailSend" }
  | { readonly _tag: "Health" }
  | { readonly _tag: "Removed" }
  | { readonly _tag: "Revalidate" };

export type RouteDecision =
  | { readonly _tag: "Route"; readonly route: ProxyRoute }
  | { readonly _tag: "MethodNotAllowed" }
  | { readonly _tag: "NotFound" };

type PostRoute = Exclude<ProxyRoute, { _tag: "Health" }>;

/** The POST route table: one case per path, `null` for anything else. */
const postRoute = (path: string): PostRoute | null => {
  switch (path) {
    case "/ai/models":
    case "/ai/toMarkdown": {
      return { _tag: "AiUnavailable" };
    }

    case "/ai/provider": {
      return { _tag: "AiProvider" };
    }

    case "/ai/run": {
      return { _tag: "AiRun" };
    }

    case "/email/relay": {
      // Tombstone: the former relay endpoint is gone and must never be parsed.
      return { _tag: "Removed" };
    }

    case "/email/send": {
      return { _tag: "EmailSend" };
    }

    case "/revalidate": {
      return { _tag: "Revalidate" };
    }

    default: {
      return null;
    }
  }
};

/**
 * Resolve one request to its route, a 405, or a 404. `/health` is GET-only;
 * every POST route is POST-only; a path outside the table is a 404 whatever
 * the method (the pre-table behavior).
 */
export const matchRoute = (path: string, method: string): RouteDecision => {
  if (path === "/health") {
    return method === "GET"
      ? { _tag: "Route", route: { _tag: "Health" } }
      : { _tag: "MethodNotAllowed" };
  }

  const route = postRoute(path);

  if (route === null) {
    return { _tag: "NotFound" };
  }

  return method === "POST"
    ? { _tag: "Route", route }
    : { _tag: "MethodNotAllowed" };
};
