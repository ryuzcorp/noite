### Fixed

- The runner's reconcile tick spawns due fleets before stopping parked ones in the same pass. Stops still complete within the pass, but a start no longer waits behind an unrelated fleet's full SIGTERM drain: under parallel Stop/Start churn the start spawned a whole slow drain late and its health gate never opened inside the UI's budget.
