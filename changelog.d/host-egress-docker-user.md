### Fixed

- Sandbox containers are reachable from tenant fleets again: the host-leg allowlist now lives in Docker's DOCKER-USER chain, where an accept preempts Docker's own drops. An accept in a separate nft table can never preempt a later drop, so the old host table never worked and is removed at boot.
- The runner now also clears raw PREROUTING rules that pin sandbox or install addresses to a single bridge, which dropped cross-bridge traffic before forwarding ever ran. Both the allowlist and the sweep re-apply on a 30s refresh because pins return as containers churn.
- The runtime image now ships the iptables client the host helper uses.

### Operator action required

- Until alpha.14 lands, installs need two manual rules to hold the path open: insert into DOCKER-USER an accept for TCP from the install subnet toward the celld bridges plus an established/related accept back, and delete any raw PREROUTING pin rules covering sandbox or install addresses. Upgrading re-applies and maintains all of it at boot and on refresh.
