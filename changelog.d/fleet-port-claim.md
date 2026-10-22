### Fixed

- **Concurrent app and environment creates no longer start two fleets on one port.** Fleet ports were picked as the lowest free pair and then inserted in a separate step, so two creates racing each other read the same free pair and the loser's celld died at bind with "exited before answering its health gate". The pick and the row insert now run under one process-wide allocation lock, so the second claim always sees the first claim's ports.
