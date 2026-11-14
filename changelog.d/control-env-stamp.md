### Fixed

- The first-admin gate now works on deployed installs. The control worker never copied the platform env into its request bag (only the runner keys were stamped), so `BASE_DOMAIN` read the dev default, `NOITE_ADMIN_EMAIL` read as unset, and a public install answered the signup policy as `off` — no code field, code-less first signup admitted as admin. The middleware now stamps every declared control key from the worker env on each request (same for the plain-route ingest path), and a missing `BASE_DOMAIN` fails closed to the strict modes instead of silently meaning localhost. Part of the first-admin gate; never shipped in a release.

### Security

- Same fix as above, defence in depth: `NOITE_AUTH_RATE_LIMIT` and the admin-email promotion paths read the same bag and saw the same dev defaults on deployed installs; they now see the deployed values.
