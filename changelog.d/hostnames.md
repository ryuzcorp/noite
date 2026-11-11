### Fixed

- **A slug that spells a platform host is refused** at create, rename and import: the reserved labels are derived from the edge route table itself, so a non-default `CONTROL_SUBDOMAIN`, an extra control hostname or the `api`/`git` hosts under any tenant base can never become a tenant site. The edge also drops, and logs, any tenant or custom-domain route that collides with a platform host.
- **`BASE_DOMAIN`, `CONTROL_SUBDOMAIN` and `CONTROL_EXTRA_HOSTS` are canonicalized on load** (trimmed, lowercased, no trailing dot), matching the `Host` normalization the edge applies, so a dotted or uppercase value no longer leaves route keys the edge can never match.

### Operator action required

- **`BASE_DOMAIN`, `CONTROL_SUBDOMAIN` and `CONTROL_EXTRA_HOSTS` must now be bare DNS names or IP literals**, and a control subdomain or extra host may not spell an `api.`/`git.` host: a scheme, port, path or api/git collision now fails validation at boot instead of leaving a claimable short host or an ambiguous route. Fix the value if the runner refuses to start.
- **An existing app whose slug already collides with a host the control plane serves** (for example a custom `CONTROL_SUBDOMAIN`) keeps its row and data but loses that host's route; the platform host serves the control plane again. Rename the app to a free slug to serve its site under a tenant hostname.
