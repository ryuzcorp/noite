### Fixed

- **Switching pages or tabs no longer flashes "Live updates are unavailable".** The hub announces only the replacement link, not the teardown of the one it replaced, and a feed that starts connecting again returns to loading — a skeleton when it has no value, its last value when it has one — instead of painting an error over a load already in flight.
- **A dropped live-feed topic no longer leaves its poller running.** Ending an attempt aborts that topic's own request, a 4xx refusal (revoked role, deleted app, unknown topic) reports a terminal refusal instead of retrying forever, and the usage stream's first-frame budget matches its 30 s poll cadence.
- **A frame that arrives before the EventSource `open` event counts as loaded**, while the hub's frameless "topic opened" marker does not: a cold or empty feed keeps its skeleton until its first real frame.
- **An auth change fences in-flight fetches by store epoch**, so signing in, signing out or impersonating in one tab can no longer replay the previous account's snapshot into the next account's panels.
- **Hub connections are rate-limited per client IP** like the other public routes, and a slow app create is recovered and granted inside the route's 15 s bound instead of timing out at 15 s while recovery continued to ~24 s.
