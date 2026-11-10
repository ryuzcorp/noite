### Fixed

- **An SMTP AUTH timeout is no longer reported as a credential failure.** A relay that timed out during authentication used to look exactly like a `535` rejection (and the endpoint logged nothing that told them apart). The timeout is now classified as a transport error, logged as such, and never triggers a credential rotation by itself.
- **`/health` no longer reports `email: true` for an SMTP config that refuses sends.** A host set with an invalid mode/port, or with `plain` mode without `VOID_PROXY_SMTP_ALLOW_PLAINTEXT=1`, made the health probe green while every send answered 502. The `email` flag now reflects what the send handler accepts.

### Changed

- The void-proxy's implicit state machines are now explicit: one route table and `matchRoute`, one per-subsystem config state shared by `/health` and the handlers, SMTP transaction phases and AUTH negotiation, per-recipient deliveries as a tagged union, one refusal-to-status table for `/email/send`, a decoded `/revalidate` purge request, and a decoded AI provider envelope. Response statuses and bodies are unchanged.
