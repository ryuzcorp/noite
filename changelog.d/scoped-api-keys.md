### Added

- **Scoped, capped and expiring API keys.** An account page key can now be limited to a set of apps, capped at a role (`view`, `push` or `admin`) and given an expiry (1 hour, 1 day, 7 days, 30 days). The effective role is the lower of the owner's role on the app and the key's ceiling, so a `push`-only agent key cannot change variables or settings, force-push or delete a branch, or commit to a protected branch even when its owner is an admin. Keys created before this are unchanged: account-wide, uncapped, never expiring.
- Every key-authenticated surface — MCP, git smart-HTTP and event ingest — now shares one authentication and one enforcement function, so the app set, the ceiling and the expiry apply everywhere, including surfaces added later. An app-restricted key cannot `create_app` or claim a new slug with a git push, and `list_apps` returns only its apps. Expired keys are refused everywhere with `API key expired`.
- The Account page's key list shows each key's apps, ceiling, expiry and last use.
- **Bot actions are attributed.** A commit the control plane makes with a key (an MCP `create_app` import, and any later key-authenticated web commit) is authored and committed as `<display name> via key <key name>`, and a preview environment redeploy triggered with a key records that label on its deploy row (`actor`), shown in the Deployments tab as "by …". Schema version 103 adds the nullable `deploy.actor` column (existing rows and automatic push deploys read `NULL`, i.e. nobody to name).

### Fixed

- **Create no longer re-grants admin to a removed or demoted creator.** A retried create (a push, MCP `create_app` or the UI) used to adopt any existing row whose `user_id` matched the caller — the creator field, not an access grant — and then grant **admin** unconditionally, so a removed or push-only creator regained admin by re-using the slug. Adoption now requires either that the account is _currently_ an admin on the app (no grant is written) or that the app has no collaborators at all and the row landed inside the 15-minute recovery window (the timed-out create whose grant never ran). Every other case answers "slug taken". The key-driven create paths also resolve the adopted app through the same key gate before returning a role, so a capped key never answers `admin`.
- A key's scope and expiry can no longer be changed through the client-reachable `/api-key/update`: they are mint-time fields, and the route now refuses them.

### Changed

- A key whose stored scope cannot be read — wrong field types, unknown fields, an empty app list — is refused instead of being treated as account-wide.
- A capped key (`view`/`push` ceiling) cannot create an app, over MCP or by pushing to a new slug: creating makes the caller its admin, which is above the key's ceiling.

### Operator action required

- Nothing to run. A key minted on an older build keeps working exactly as before; new keys default to the previous behaviour unless an owner narrows them.
