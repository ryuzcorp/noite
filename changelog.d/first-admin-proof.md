### Operator action required

- First-run admin is now proof-gated. On a fresh public install the first registration must present the one-time setup code printed at boot (`docker compose logs noite | grep "FIRST ADMIN"`), unless `NOITE_ADMIN_EMAIL` names the address that may claim the admin slot. The installer now asks for that address and persists it to `.env` (`--admin-email` / `NOITE_ADMIN_EMAIL` for scripted installs). `localhost`-family bases are unchanged (no code, first account wins). If you upgrade with users but no admin on a public base, the next registration must present a fresh code (`docker compose exec noite noite-runner setup-code`).

### Security

- Fixed N-3: the first account on a fresh public install no longer becomes admin unconditionally. A stranger who reaches the control UI before the operator (the hostname appears in certificate-transparency logs at first issuance) is refused while no admin exists; with `NOITE_ADMIN_EMAIL` set only that address may claim the slot, otherwise a 100-bit one-time setup code (stored as a SHA-256 hash, single-use, consumed atomically with the claim so two racing sign-ups cannot both win).

### Changed

- The sign-up form shows a setup-code field on a fresh public install without `NOITE_ADMIN_EMAIL`, and a notice when the slot is reserved for the configured admin address. The public `/api/invite/status` policy now reports `adminExists` and `setupMode` (`off` | `email` | `code`); it never carries the code or the address.
