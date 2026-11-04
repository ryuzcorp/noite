### Added

- Every fleet node (tenant fleets and the control node) now runs with a random per-fleet `CELLD_OPERATOR_TOKEN`: celld requires it as `Authorization: Bearer` on every internal-listener route, and the runner sends it back on its own internal calls (`POST /reload`, the DO `?read=1` probe, the `celld` CLI subprocesses). Tokens are minted once per fleet, stored AES-encrypted like the scoped bucket keys, and never reach tenant code (Worker envs come from declared vars only; `CELLD_*` stays reserved out of fleet process env). Liveness probes use the public health endpoint, which the token does not guard.

### Changed

- Worker egress in `multi` is now enforced inside celld (`CELLD_EGRESS=public` with the object store as the one `CELLD_EGRESS_ALLOW` exception) instead of by the fleet-uid half of the nft table, which is deleted; the nft table now covers the per-app build range only. Loopback and private-range dials from Workers stay refused, and the operator API answers 401 without the fleet's token on top. Dials to container endpoints the node published are exempt node-wide, which Noite accepts (the sandbox gateway still admits only dials to containers the connecting fleet owns).
- Fleets in their own cgroup leaf now shed against it (`CELLD_MEMORY_SCOPE=self`): an unset `RUNNER_FLEET_MAX_RSS_MB` sheds gracefully at 80% of the fleet's own `memory.max` before the kernel OOM-kills it, instead of measuring the container as a whole.
- `make doctor`'s `celld diagnose` reads the control token from the root-only `<work-dir>/control-operator-token` the runner rewrites on every control spawn; without it the peer probes fail closed with 401s.
- Fleet spawns now apply tenant vars before platform knobs (platform always wins by construction) and remove each celld knob they do not explicitly set instead of inheriting operator-global values — including `CELLD_MAX_RSS_MB` when `RUNNER_FLEET_MAX_RSS_MB=0`, which previously leaked a global value into every fleet.
- When the control fleet's operator token cannot be ensured, the control fleet does not run at all (failing closed) instead of running with an open internal listener.

### Operator action required

- The runner database migrates to schema 15 automatically (new `fleet_operator_token` table); downgrading past this release is refused, as usual.
- Anything outside the runner that calls a fleet's internal API directly (for example a script that POSTs `/reload`) must now send `Authorization: Bearer <fleet token>`; the runner's own calls already do. The control fleet's token for `celld diagnose`-style tooling is published root-only at `<work-dir>/control-operator-token` inside the container.
