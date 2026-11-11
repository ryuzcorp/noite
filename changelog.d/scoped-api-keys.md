### Added

- **Scoped, capped and expiring API keys.** An account page key can now be limited to a set of apps, capped at a role (`view`, `push` or `admin`) and given an expiry (1 hour, 1 day, 7 days, 30 days). The effective role is the lower of the owner's role on the app and the key's ceiling, so a `push`-only agent key cannot change variables or settings, force-push or delete a branch, or commit to a protected branch even when its owner is an admin. Keys created before this are unchanged: account-wide, uncapped, never expiring.
- Every key-authenticated surface — MCP, git smart-HTTP and event ingest — now shares one authentication and one enforcement function, so the app set, the ceiling and the expiry apply everywhere, including surfaces added later. An app-restricted key cannot `create_app` or claim a new slug with a git push, and `list_apps` returns only its apps. Expired keys are refused everywhere with `API key expired`.
- The Account page's key list shows each key's apps, ceiling, expiry and last use.

### Changed

- A key whose stored scope cannot be read is refused instead of being treated as account-wide.

### Operator action required

- Nothing to run. A key minted on an older build keeps working exactly as before; new keys default to the previous behaviour unless an owner narrows them.
