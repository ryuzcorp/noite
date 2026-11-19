### Operator action required

- The tenant runtime moves from celld to **Cello 0.1.0**. Re-running the installer rewrites stale `CELLD_*` keys in `/opt/noite/.env` to their `CELLO_*` spellings automatically (a pre-existing `CELLO_*` value wins; duplicate legacy lines migrate in order so the last value still wins). A migrated `CELLD_BIN` pointing at a `celld` binary becomes its `cello` sibling (reported in the migration output); any other kept or migrated `CELLO_BIN` whose basename is not `cello` is left alone with a warning — verify it points at the cello binary before the next fleet launch. The runner now **refuses to boot** with any `CELLD_*` still set, naming the `CELLO_*` spelling — remove leftovers instead of leaving them.
- `RUNNER_FLEET_LOG`'s default is now `error,cello=warn`. An explicit override keeps working; one pinned to `error,celld=warn` still boots but matches nothing — update it to see fleet warnings.
- The instance heartbeat payload field `celld_version` is now `cello_version`. Dashboards or alerts keyed on the old field name need the new spelling.
- On upgrade the runner removes the orphaned pre-Cello `celld`/`celld-internal` container networks when no container is attached to them. A network still in use is left alone and logged — drain its containers (or remove the network by hand once idle) so fleet-to-container dials stay behind the ownership-checking gateway.

### Changed

- Tenant fleets, the control fleet and every `cello` CLI call now run Cello 0.1.0 (image `ghcr.io/ryuzcorp/cello:0.1.0`, pinned by digest with the same attestation gate). Fleet health moves to `/.well-known/cello/health`; error grouping unwraps both `cello.*` and legacy `celld.*` span names, so telemetry from before the upgrade keeps working and old buckets still load.
- The sandbox plane, relay, gateway and engine proxy share one source of truth for Cello's `cello`/`cello-internal` bridges (`cello0`/`cello1`): fleet-to-container dials always land on the ownership-checking gateway, and the installer only renames real `CELLD_*=…` assignments (a bare `CELLD_*` line without `=` is left untouched).
