### Fixed

- Two accounts created at the same moment on a brand-new instance can no longer both become an admin: the bootstrap role is now claimed with one conditional write, and the loser is refused instead of admitted without an invite code.
- An invitation code whose redeemer's account was deleted no longer shows up as "available" in the admin invite list, and Revoke on an already-used code reports that instead of claiming success.
- Re-inviting an existing collaborator can no longer demote an app's last admin, and accepting an older invitation no longer silently overwrites a newer role grant.
- The dashboard no longer hangs on its loading skeleton forever when the session read fails: it shows the error with a Retry button, and a failed read is not treated as "signed out".
- Signing in now verifies the session cookie like registration does, so a sign-in that resolves without a session shows an error instead of bouncing between `/apps` and `/login`.
- The login panel no longer swaps "Sign in" for "Create account" under the pointer while the signup policy is loading.
- The first-run tour keeps its dialog open when saving the "onboarded" mark fails, shows the error, and offers to skip, instead of silently reappearing on every reload.
- The release-check and telemetry cards keep showing "Checking…" until the check reports, no longer keep a stale "saved" after another tab changes the setting, and show the stored preference while an operator lock is in force.
- The admin Apps tab no longer offers a Start button for an app whose desired state is unknown (a click that reported success and did nothing), and a row's action no longer disables every other row.
- Deleting the last passkey is refused (add another device first) instead of leaving an account that can only be recovered when email delivery is configured.
- An API key can no longer be created with no scope selected.

### Changed

- The implicit UI state machines in the account, auth, admin, update, telemetry, dialog, confirm and MCP areas are now explicit closed types with one transition function each (instance-admin authority, session read, registration/bootstrap, invite-code lifecycle, app membership, admin row states, settings cards, tour, session gate, MCP auth and protocol-version handshake); agents can read each machine from its module doc comment.
