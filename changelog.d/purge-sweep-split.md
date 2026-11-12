### Fixed

- The orphaned CI-cache-volume sweep on the reconcile loop is now its own slow-tick pass with its own timer and in-flight flag. It used to share the purge-resume task, so a wipe resume that held a slug guard for seconds kept the sweep from running for a whole interval, and a long sweep delayed the next resume. The sweep still runs detached, never under a slug guard, and a failure only logs and retries on a later pass.
