### Changed

- Fleet deploys now stage every script with `celld deploy --no-activate` — the cohosted scripts first (each skipped when its content hash matches the stored one), the tenant app last — then serve the generation with one `celld activate SCRIPT=VERSION...` (a single atomic pointer write, always with `--primary` on the app). A failed stage runs no activate, so the previous generation keeps serving; there is no window where the fleet pointer names a half-deployed fleet. The fence-image `AlreadyExists` retry rationale is gone with celld's own fix; the generic one-infra-retry per command stays. Stored cohost hashes now name activated content (written only after the activate commits).

### Operator action required

- Requires celld `v0.6.3-ryuzcorp.6` (staged activation): do not deploy this runner against an older celld.
