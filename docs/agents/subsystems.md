# Subsystem contracts

SPEC.md is the design record; this page keeps only the operational rules and the lessons that are not in it. Read the linked section before touching that code.

- **Observability / telemetry substrate** — [SPEC: Observability](../../SPEC.md#observability-the-pricing-substrate): the flush/retention knobs, the `_control` source, compaction, ingest idempotency and error tracking. Never read Parquet on a request path, and never make an ingest writer additive (a failed pass must not advance the watermark).
- **Cello alignment** — [SPEC: Cello alignment](../../SPEC.md#cello-alignment), with the control node in [SPEC: Control UI](../../SPEC.md#control-ui-fleet-0), the edge in [SPEC: Edge](../../SPEC.md#edge), isolation in [SPEC: Tenant isolation](../../SPEC.md#tenant-isolation), runner state in [SPEC: Runner state](../../SPEC.md#runner-state), limits in [SPEC: Limits](../../SPEC.md#limits), tenancy in [SPEC: Tenancy mode](../../SPEC.md#tenancy-mode), boot/stop order in [SPEC: Boot order](../../SPEC.md#boot-order-the-upgrade-window), releases in [SPEC: Install targets](../../SPEC.md#install-targets) and operator recovery in [SPEC: Operator recovery](../../SPEC.md#operator-recovery).
- **Worker code rules** — [SPEC: Worker code rules](../../SPEC.md#worker-code-rules): nothing crosses requests; isolate-level setup runs once, concurrently-safe; actions are bounded; the control D1 editor is in-process.
- **Preview environments** — [SPEC: Environments](../../SPEC.md#environments-previews): the label rules (`host/env_label.rs`), the `envs/<slug>/<label>` prefix, the access gate's token and cookie (`host/env_gate.rs`), the caps and scale-to-zero. Two invariants: an environment deploy must never write the app's fleet columns, bucket or `last_deploy_sha`, and an environment's storage starts empty — never seed it from production. There is no workspace preview: it was removed with the in-browser pod, and a boot step tears down any `kind='workspace'` row an upgrade left.

## Instance telemetry

**Instance telemetry:** never add or rename a field in the `instance_heartbeat` payload without updating [the telemetry docs page](../../apps/website/docs/self-hosting/telemetry.mdx) in the same change, and never let a test send a real event to PostHog — inject the sender and assert on the built payload.
