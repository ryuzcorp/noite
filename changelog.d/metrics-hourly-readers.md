### Changed

- The **Metrics** tab and `GET /v1/apps/{id}/metrics` now serve **hourly** counters instead of minute buckets, straight from the edge: each row is one `(app, environment, hour)` with the served request count, its 5xx errors (the tab shows the error rate), p50 and p95 latency, the fleet's peak and mean memory, and CPU time. The tab keeps the request, error and CPU bars, adds per-hour p50/p95 latency and memory charts, and the tiles show requests, error rate, p50/p95, peak memory and CPU. Memory and the percentiles are new; the old average latency (a sum) is gone.
- `GET /v1/apps/{id}/metrics` rows are `{appId, bucketTs, requests, errors, p50Ms, p95Ms, memoryMaxBytes, memoryAvgBytes, cpuMs}` and `bucketTs` is an hour stamp. `GET /v1/apps/{id}/metrics/version` now also moves when a counter row is rewritten, so the dashboard refreshes on the next poll instead of waiting for a telemetry flush.
- **Breaking:** `GET /v1/apps/{id}/devices`, `/paths`, `/refs` and `/spans` (and the `spans.get` RPC) are removed, together with the Metrics tab's Spans table and the Analytics cards (browsers, operating systems, paths, referrers). Their tables are still written until the DuckDB stack is removed, but nothing reads them.
- Scale-to-zero now reads the hourly counters' exact request stamp, so idle detection is no less precise than before (hour granularity alone would have loosened it by up to an hour).

### Fixed

- A burst skip in the access-log tail (over 8 MiB unread in one tick, when every buffered line is dropped) is now recorded as an instance setting and makes the idle sweep skip that app while the skip falls inside its sleep window. Before, one flooded feed could park actively-served apps on the next sweep; explicit sleeps and memory-pressure parking are unaffected.

### Operator action required

- Anything scraping `/devices`, `/paths`, `/refs` or `/spans` must stop: those routes are gone. `/metrics` keeps its path but returns hour buckets and no longer carries `latencyMs` — read `p50Ms`/`p95Ms` for latency.
