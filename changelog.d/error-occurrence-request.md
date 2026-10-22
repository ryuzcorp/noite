### Fixed

- **Worker error occurrences no longer lose their request.** A failed span ingested before its access-log line was tailed stored its occurrence without method, path or status, and the re-read dedup kept the empty row forever — the Errors tab showed a blank request for an error whose line was in the log. The access-log tail now runs before the ingest each tick, and a span that still ingests first is marked pending so the tail backfills the stored row when the line lands.
