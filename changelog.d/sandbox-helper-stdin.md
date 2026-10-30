### Fixed

- Sandbox apps (the agent template) can actually reach their containers: the alpha.12 host-table helper piped its ruleset into `docker run` without `-i`, so the container's stdin arrived closed, `nft -f -` applied nothing, and still exited 0 — the runner logged "installed" while the host kept dropping install↔sandbox traffic (Clone/Task 504). The helper now keeps stdin open and lists the table back before reporting success.

### Operator action required

- Alpha.12 installs are missing the host table: upgrading re-applies it at boot (the `sandbox host table installed` log line now means it). Until then, install it once by hand — it persists until the next host reboot. With your install subnet from the runner boot log (`install subnets`, e.g. `172.18.0.0/16`), feed `sudo nft -f -` a `table inet noite_sandbox` (delete then define) carrying `chain forward { type filter hook forward priority -15; policy accept; ip saddr { <subnet> } oifname { "celld0", "celld1" } meta l4proto tcp accept; iifname { "celld0", "celld1" } ct state established,related accept; }`, then confirm with `sudo nft list table inet noite_sandbox`.
