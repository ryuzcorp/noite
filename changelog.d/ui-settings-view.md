### Changed

- **Settings is a view of its own, under Pull requests in the sidebar** (`/apps/<id>/settings`), not a side panel on the app page and no longer an item in its tab row. The sections — Identity, Domains, Limits, Error reporting, Collaborators and Environment variables, plus Branch protection and Danger zone for admins — are the view's tabs, one at a time, with `?section=` as the deep link (`/apps/<id>/settings?section=domains`). Old `?panel=settings` links redirect to the view and carry a known `?section=` along; unknown ones land on Identity.
