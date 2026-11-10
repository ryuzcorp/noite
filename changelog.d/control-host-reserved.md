### Fixed

- A slug that spells a platform host is now refused at create, rename and import: the reserved labels are derived from the edge route table itself, so a non-default `CONTROL_SUBDOMAIN`, an extra control hostname or the `api`/`git` hosts under any tenant base can never become a tenant site. The edge table also drops any tenant or custom-domain route that collides with a platform host (logged), so the control plane's hostname always reaches the control fleet.

- `BASE_DOMAIN`, `CONTROL_SUBDOMAIN` and `CONTROL_EXTRA_HOSTS` are canonicalized (trimmed, lowercased, no trailing dot) on load, matching the `Host` normalization the edge already applies; a dotted or uppercase value no longer leaves route keys the edge can never match.

### Operator action required

- `BASE_DOMAIN`, `CONTROL_SUBDOMAIN` and `CONTROL_EXTRA_HOSTS` values must now be bare DNS names or IP literals: a scheme, port or path was never matchable by the edge and now fails validation at boot instead of leaving a claimable short host. Fix the value if the runner refuses to start.
- An existing app whose slug already collides with a platform host (for example it matches a custom `CONTROL_SUBDOMAIN`) keeps its row and data but loses that host's route: the platform host serves the control plane again. Rename the app to a free slug to serve its site under a tenant hostname.
