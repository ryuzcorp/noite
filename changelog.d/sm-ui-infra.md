### Fixed

- A dropped live-feed topic no longer leaves its in-process poller running: ending an attempt aborts that topic's own request, so a stalled metrics/apps stream stops polling instead of stacking one orphan per retry.
- A live feed refused with a 4xx (revoked role, deleted app, unknown topic) now reports a terminal refusal instead of retrying forever.
- The usage stream's first-frame budget now matches its 30 s poll cadence, so a quiet or failed cycle is no longer dropped and reopened in a loop.
- A frame that arrives before the EventSource `open` event now counts as loaded, instead of painting the skeleton over data that was already there.
- Panels no longer treat the hub's frameless "topic opened" marker as loaded: a cold or empty feed shows a skeleton until its first real frame.
- Signing in, signing out or impersonating in one tab no longer replays the previous account's live-frame snapshot into the next account's panels.
- An auth change now fences in-flight snapshot fetches and resource lookups by store epoch, so the previous account's response can no longer land in the next account's cache.
- Hub connections are now rate-limited per client IP like the other public routes (one bucket per connection, not per topic).
- A slow app create (detached in the runner) is now recovered and granted inside the route's 15 s bound; it used to time out at 15 s while recovery continued to ~24 s.

### Changed

- The stream hub, live feed, resource reader, rate limiter, runner failures, query-string cell and request timeout now have explicit state types and one transition function each (hosted in the streaming, resource, rate-limit, runner and search-param modules); resource and feed consumers read one `state` accessor instead of `data()`/`error()`/`loading()`/`latest()`/`status()` combinations.
