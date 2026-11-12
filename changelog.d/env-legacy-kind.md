### Fixed

- **A failed upgrade teardown no longer breaks environment listings.** A retired `kind='workspace'` row surviving a non-fatal boot teardown is now skipped by every environment read — an app's preview list, the install-wide listing and the route table — instead of failing the whole query on a decode error; the next boot still removes it.
