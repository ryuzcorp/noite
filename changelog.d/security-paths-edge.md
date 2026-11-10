### Security

- The security gate now treats the bundled Caddy edge module (`edge/**`) and the static Caddyfile writer that consumes its table (`apps/runner/src/host/caddy.rs`) as sensitive: a change to the route table, the host matcher, the rate limiter or the gate/asleep hops needs an independent review and the `security-reviewed` label.
