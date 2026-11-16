### Added

- Responses from a Noite edge's routes carry `Server: noite`: apps, the control UI, the API and the edge's own pages. The value replaces Caddy's default and any `Server` header the app sent, as Cloudflare and Vercel do for their edges. An ACME HTTP-01 challenge response, which Caddy answers before any route, keeps `Server: Caddy`, and a proxy in front may replace the value.
