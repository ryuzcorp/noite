### Fixed

- Apps no longer all restart together when the host stalls briefly. Each celld node renewed a 10 s lease in the store and stopped itself when a renewal ran late. On a small host, any disk or storage stall of about 7 s (for example while a Sandbox container started) restarted every app and the control UI at once. Each restart also threw away the app's Sandbox containers, so agent-template clones restarted from scratch and looked stuck. The lease now lasts 60 s (`RUNNER_FLEET_LEASE_TTL_MS`, minimum 10000).
