### Fixed

- Deleting an app no longer fails with "The operation was aborted due to timeout". The control UI gives every runner call 5 s. A delete purges the app's whole storage prefix (thousands of telemetry objects after a few days) and waits out a deploy in flight, which takes much longer on a slow host. The runner now answers within 3 s: the app disappears from every listing at once and the purge finishes in the background. If the purge fails, it is logged and the app comes back stopped with the error on it, ready to be deleted again.
