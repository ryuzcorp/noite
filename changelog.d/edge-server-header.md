### Added

- Every HTTP response from a Noite edge carries `Server: noite`, replacing Caddy's default and any `Server` header the app sent (Cloudflare and Vercel do the same for their edges). Fingerprint the stack on that value; a proxy in front may replace it with its own.
