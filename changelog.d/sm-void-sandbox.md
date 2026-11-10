### Fixed

- A sandbox cell whose stop was interrupted at the wrong moment could stop counting against the fleet's concurrency limit, refusing new sandboxes until the cell was redeployed. Every capacity entry now schedules its own cleanup sweep, and a stop never saves its marker before that sweep is armed.
- A sandbox request that arrived while the idle alarm was tearing the cell down could run against a container that was already being destroyed. The cell now refuses the request with `VOID_SANDBOX_unavailable` instead of racing the teardown.
- A stopped sandbox lease that was asked to confirm a start could leave its container running with no durable record able to stop it. The refusal now tears the container down.

### Changed

- The sandbox controller's lease, admission entry, idle/activity tracking and stream bridges are explicit state machines with one transition function each; behaviour and Durable Object storage shapes are unchanged.
