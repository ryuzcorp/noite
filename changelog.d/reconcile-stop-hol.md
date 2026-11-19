### Fixed

- The runner's reconcile tick stops all desired-stopped fleets concurrently instead of awaiting each SIGTERM drain one by one. Under load, several draining fleets used to serialize the whole tick, so an unrelated fleet's start waited behind stops it had nothing to do with and its health gate never opened in time.
