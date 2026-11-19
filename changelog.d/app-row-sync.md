### Fixed

- The app page's status badge no longer wedges on a stale Stop/Start transition. A superseded app-row fetch used to overwrite the shared snapshot while its paint was dropped, so the next state-stream frame matched the stale snapshot and invalidated nothing; and a failed row refetch kept the old value with no recovery. The snapshot now moves with its paint (only the latest reload writes it), and the app row and environments refetch with a bounded retry, so every delivered frame converges the badge without polling.
