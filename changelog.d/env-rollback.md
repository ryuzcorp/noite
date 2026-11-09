### Added

- **Roll back a preview environment.** A successful deploy row under a preview environment now offers **Roll back** like production: the sha must have been successful in that environment (a production success never authorizes it), and the rebuild lands in that environment's fleet. The production-only restriction is gone from the Deployments tab's environment groups.
