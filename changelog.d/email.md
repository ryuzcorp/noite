### Fixed

- **A failed `/email/send` no longer becomes permanent for its idempotency key.** Only an attempt where a delivery was observed accepted is recorded; a full or partial accept replays byte-identically and sends nothing, while a failed, outcome-unknown or rejected-only attempt records nothing so the retry really retries. An `outcome_unknown` retry can still duplicate a message the relay already queued, which the per-recipient error says.
- **An SMTP AUTH timeout is a transport error, not a credential failure.** It is classified and logged as such and never triggers a credential rotation by itself.
- **`/health` no longer reports `email: true` for an SMTP config that refuses sends.** An invalid mode/port, or `plain` mode without `VOID_PROXY_SMTP_ALLOW_PLAINTEXT=1`, now shows the same verdict the send handler gives.
