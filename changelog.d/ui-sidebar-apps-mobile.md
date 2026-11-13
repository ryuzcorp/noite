### Changed

- The sidebar's live app list is part of the shell now: it shows on every page, not only under `/apps` and `/storage`. It reads the same live stream the `/apps` list does (one SSE topic, one connection per page, and the cached snapshot across navigations — no refetch per page), and an app's row still expands into App, Code, Pull requests and Settings with the part of the app the URL is in highlighted.

### Fixed

- The phone sidebar closes when a destination in it is tapped — an app, the app's own items, or an item in the profile menu — instead of staying open over the page it navigated to. The profile row itself still opens its menu.
- The phone sidebar has breathing room above the Apps item, and Esc closes it and returns focus to the toggle. The toggle is a real button now, so the drawer can be opened from the keyboard too.
- The open phone drawer now paints above the page's own stacked chrome (the sticky mobile top bar, a page's sticky tab row), instead of those bars drawing over the app list.
