### Fixed

- Code mode no longer gets stuck on **Switching to …**: a request for the ref the panes still show (the one you click back to while another is opening) is a new switch instead of a no-op, so the ref machine can no longer stay in its `Opening` state with nothing running for it. A switch whose pod takes the `open` and never answers now ends on **Could not open** with **Retry** after a bounded wait (`OPEN_DEADLINE_MS`), instead of spinning forever.
