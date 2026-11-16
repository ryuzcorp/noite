### Removed

- Invitation codes are gone: the invite-code pool, the admin **Invites** tab, the signup code field, and every account's own share (`INVITES_PER_USER`) are removed. Outstanding codes stop working — the `invite` table is dropped by migration.
- Per-account invite codes are replaced by admin-sent **email invitations**: an admin invites an address on the Users tab and the one-time link (`/login?invite=…`, single-use, 7 days, bound to the address) is shown once for copying and emailed when delivery is configured. The signup form takes an optional token instead of a required code.

### Added

- Registration waitlist (off by default, on the Noite app's **Settings** tab): with it on, an uninvited registration creates a `pending` account that holds no access — no page data, no API calls, no key use — until an admin approves it on the **Users** tab (pending badge plus Approve/Reject; approval optionally emails the new account). With it off, uninvited registration is refused outright. Sign-up attempts are rate-limited and pending accounts are capped at 200.

### Operator action required

- Outstanding invitation codes stop working on upgrade. Re-invite the people you invited by email from the Users tab; enable the waitlist in Settings if you want uninvited registrations to queue for approval instead of being refused.
