### Changed

- **Every admin surface is in one place.** The instance-wide switches left `/account`: the anonymous-telemetry opt-out and the release check now live on the control page's new **Settings** tab (`/apps/_control?t=settings`), next to Users, Apps and Invites. `/account` is personal settings only — profile, passkeys, API keys, your own invite codes and agent connect — and the header keeps its `admin` badge. Nothing loosened: both actions still refuse anyone but a real instance admin on the server (`requireControlAdmin`), and `/apps/_control` still answers "App not found." to everyone else. The retired `/account?t=admin` link (docs, bookmarks) redirects to the Settings tab, and the docs, `SPEC.md`, `README` and the website pages name the new home.

### Operator action required

- None. `/account?t=admin` still works (it redirects); an operator who wants telemetry off or release checks disabled finds both switches on the control page's **Settings** tab, and the same environment variables (`NOITE_TELEMETRY`, `NOITE_UPDATE_CHECK`) still win over them.
