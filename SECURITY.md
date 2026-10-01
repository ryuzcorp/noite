# Security policy

Noite is alpha software that people run on their own servers. Please read [Known limits](https://noite.now/self-hosting/known-limits) first: the isolation gaps listed there (shared build user, root bucket keys in fleets, unverified custom domains, no per-app memory cap) are known and tracked, and need no report.

## Reporting a vulnerability

Report it privately through GitHub: **<https://github.com/ryuzcorp/noite/security/advisories/new>** (the repository's "Report a vulnerability" button under the Security tab).

Please do not open a public issue or pull request for a vulnerability, and do not post it in a community channel.

A useful report has the release (`docker compose images`, or the image tag), what you did, what you expected and what happened. A proof of concept helps; a hostile-tenant app that escapes the sandbox is the most valuable kind (the `make e2e-isolation` lane's `hostile` spec is the format to follow).

## What to expect

- An acknowledgement within 7 days.
- A fix or a mitigation plan for confirmed issues, and a note in the [CHANGELOG](CHANGELOG.md) under "Operator action required" when an install must act (rotate a secret, change a setting).
- Credit in the advisory, unless you prefer not to be named.

Alpha releases are supported on the newest release of their channel only: fixes ship as a new release, not as a patch to an old one.

## Scope

In scope: the runner, the control UI, the install scripts and the image. Authentication and invites, tenant isolation, the Git adapter, the edge configuration, and secrets handling are the areas that matter most.

Out of scope: findings that need access the operator already has (a shell in the container holds every secret by design), `NOITE_TENANCY=single` installs where tenants are trusted by definition, and denial of service from a tenant that the documented per-app and edge rate limits already bound.
