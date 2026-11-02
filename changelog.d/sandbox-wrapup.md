### Operator action required

- Sandbox containers gain a kill switch: `NOITE_SANDBOX=0` (also `false`/`off`) in `.env` disables the relay, the per-fleet engine sockets and fleet `DOCKER_HOST`, and deploys declaring `containers` fail with a clear error. Unset stays on when the engine socket answers. Set it on rootless-engine hosts (celld's fence needs `NET_ADMIN` in the host netns, which a rootless engine cannot grant) or where no app uses Sandbox containers.
- Docker 26 or newer is now required for Sandbox containers: the relay container mounts its socket directory with a volume subpath, which older daemons refuse.
- Sandbox containers created before this upgrade carry no fleet label, so the runner's automatic cleanup cannot see them. After upgrading, list them with `docker ps -aq --filter label=celld.cell` and remove the stale ones with `docker rm -f` — but only when no other celld outside Noite runs on the host, since the filter matches every celld container on the daemon, not just Noite's.

### Fixed

- Agent-template sandboxes are reachable again: since alpha.10 every dial from a tenant fleet into its Sandbox container timed out, because celld's own host fence rejects replies addressed at the private compose bridge. Container traffic is now relayed from the host network namespace, where the fence admits the replies — with no host firewall edits by Noite.

### Security

- Tenant fleets no longer hold the host engine socket: each fleet gets a filtered per-fleet engine API served by the runner (validated container, network and image calls only), and only the runner keeps the real socket.
- Cross-app sandbox dials are refused: a fleet reaches only the containers it owns.
- The host-network container celld uses to install its firewall now always runs from Noite's own image with celld's exact ruleset, never from an image a tenant deployed. Sandbox containers must name a deployed image by content key and carry CPU and memory limits (at most celld's largest instance type); network inspects no longer list other apps' containers.
- Sandbox container cleanup is scoped to this install (`noite.install` label), so two installs sharing one engine never remove each other's containers, and orphans are also removed when `NOITE_SANDBOX=0`.
- Deploys declaring `containers[]` with a `Dockerfile` image (which celld would build on the host engine outside its fence) or a per-class `runtime` (the OCI runtime is operator-owned) now fail with a direction.
- The alpha.12–14 host firewall legs are gone: the four DOCKER-USER rules and the stale `noite_sandbox` table are removed automatically at boot, and Docker's own raw PREROUTING rules are no longer deleted.
