### Security

- The security gate now treats the bundled Caddy edge module (`edge/**`) as sensitive: a change to the route table, the host matcher or the rate limiter needs an independent review and the `security-reviewed` label, like the runner files that feed it.
