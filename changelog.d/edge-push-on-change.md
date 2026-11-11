### Changed

- **An idle runner no longer re-sends the whole edge route table every 5 s.** The reconcile tick builds the table as before, but POSTs it only when the table changed since the file was written; otherwise it asks the edge which generation it serves (`GET /edge/routes`, a few bytes over loopback) and skips the push when the answer is the current one. A Caddy that restarted and lost its in-memory table reports a different generation, so the next tick pushes again; a refused or unanswered push is still retried on the next tick. No configuration change.
