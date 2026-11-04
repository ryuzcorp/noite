### Changed

- Void redeploys now run the `migrate` step against the staged generation through `celld invoke` before the `activate` moves traffic to it: the staged cohosted pins plus the app as `--target`, the fleet's `__VOID_PROXY_TOKEN` on `x-void-internal`, the operator token and fleet HMAC over `CELLD_*` like `celld d1 execute`. The endpoint protocol, capability negotiation and attempt reconciliation are unchanged — only the delivery moved. A failed staged `migrate` runs no activate, so the previous generation keeps serving; there is no longer a window where new code serves the old schema. First deploys — and fleets with no live node for the invoke — still migrate after adoption, as before.

### Operator action required

- Requires celld `v0.6.3-ryuzcorp.7` (staged invocation): do not deploy this runner against an older celld, whose `invoke` subcommand does not exist.
