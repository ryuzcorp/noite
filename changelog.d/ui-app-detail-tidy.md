### Changed

- **App detail: Sync from GitHub is a tiny header button, Analytics is its own tab.** The Overview tab no longer carries a Sync from GitHub card: GitHub-imported apps (push role) get a small button next to the status line in the header instead. A click syncs straight when the tree is clean; when Noite-side commits would be overwritten it opens a modal dialog with the overwrite confirmation ("Sync anyway"). The dialog also carries the origin facts (origin, last synced sha, origin tip) and the result ("Synced to \<sha\>", up-to-date, or the runner's refusal). The tooltip on the button names the origin and both shas.
- **The Analytics breakdowns moved out of `?t=metrics` into a standalone `?t=analytics` tab** right after Metrics, over the same window (`?r=`) and environment (`?env=`). The Metrics tab keeps the stat tiles and charts; neither tab shows a "Metrics"/"Analytics" section heading. Old `?t=metrics` links still land on the charts. The breakdowns are exported as `AnalyticsCard` so the control app page can mount the same surface.

### Fixed

- **The Errors tab's top spacing matches the Events tab.** The environment picker moved into the Errors card's header row (next to the status tabs) instead of its own right-aligned row above the card, and the error detail's back link shares its row with the picker — the same container/gap/header pattern as Events.
- The Deployments tab no longer paints the "No environments yet — …" line when the app has no preview environments; the section just lists production deploys and the create-environment dialog.
