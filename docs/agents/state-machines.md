# State machines

Every lifecycle in the product is one closed type with one transition point (decision 2026-11-10, "One explicit state-machine pattern per layer"). Read before adding or changing one.

## Rules

- Never compare status strings or combine flags to infer a state. Read the type, branch with an exhaustive `match`/`switch` (`satisfies Record<Tag, …>` tables in TS), and add new states as variants.
- Adding a variant means updating its transition table/diagram in the module doc and its table test in the same change. Every machine module documents its states (mermaid `stateDiagram-v2` or a table) and has a `*.test.ts`/`#[test]` transition table.
- Persisted state keeps its wire/DB strings. Runner statuses are Rust enums (sqlx TEXT, ts-rs unions in `apps/noite/src/lib/runner-types/`) written only by guarded `UPDATE … WHERE status IN (predecessors)` writers that report `Applied`/`Refused`, never by an unconditional `SET status`.
- A stale async answer is refused by a token, epoch or generation carried in the state (`pane-view.ts` token, `FleetEntry` epoch, sandbox lease generation, `swrEpoch`), never by a "still mounted" flag.

Runner paths are under `apps/runner/src/`; control paths (`http/`, `lib/`) under `apps/noite/src/`.

## Where each pattern lives

| Layer | Pattern | Where |
| --- | --- | --- |
| Runner, persisted | enum + `predecessors()` + guarded writer | `models.rs` (`AppStatus`, `DeployStatus`, `DesiredState`, `EnvironmentKind`, `EnvSource`, `PrState`, `ReviewState`, `DomainStatus`, `IssueStatus`), `db/{apps,deploys,environments,prs,credentials}.rs` (domain verify outcome `VerifyOutcome` in `db/apps.rs`), `service/prs.rs` (`MergeState`) |
| Runner, folded from rows | enum + pure `step` folded over persisted rows; no column of its own | automatic-deploy budget `host/auto_deploy.rs` (`models.rs` `AutoDeploy`, per target, over its deploy rows) |
| Runner, in memory | `enum State` + one transition fn | deploy cancel `host/cancel.rs` (`RunState`); import/delete `host/import.rs`, `service/apps.rs` (`Deletion`); fleets `host/supervisor.rs` (`FleetState`, spawn epoch; crash/OOM hold `models.rs` `FleetHold`, served as `fleetHold`, never a column), `host/children.rs` (`ChildState`), `host/cgroups.rs` (`OomState`), `host/state.rs` (`SnapshotPhase`), `host/rehydrate.rs` (`MirrorState`), `host/isolation.rs` (`Capability`); edge route table pushes `host/edge_table.rs` (`Pushed`); readiness `main.rs` (`Readiness`, `ReadyFailure`); telemetry/update/compaction/access log `host/{telemetry_report,update_check,metrics/compact,accesslog}.rs`; SSE `api/sse.rs` (`StreamPhase`); git mirror `host/forge.rs` (`MirrorPhase`) |
| Edge (Go) | `Phase` constants under the mutex, lock-free published snapshot | `edge/{edge,table,ready}.go` |
| CLI | TaggedEnum + pure `step` | `packages/cli/src/{config,deploy,git,gh,mcp,temp}.ts` |
| Void proxy / sandbox | TaggedEnum (or `_tag`) + pure `step`; DO storage shapes unchanged | `apps/void-proxy/src/{ai,config,routes,revalidate,email/send,email/smtp}.ts`; `apps/void-sandbox/src/{lease,admission-entry,activity,bridge}.ts` |
| Control server | closed outcome types | stream hub topics `http/routes/stream-hub.ts`; rate limit `lib/rate-limit.ts`; authority `lib/authority.ts` (the one admin predicate); membership `lib/membership.ts`; invites/bootstrap `lib/server/invites.server.ts`; sessions `lib/server/session.server.ts`; key auth `lib/server/key-auth.server.ts` + key scope/ceiling/expiry enforcement `lib/server/key-access.server.ts` (one principal, `lib/key-principal.ts`) |
| UI shared state | one atom holding a `Data.TaggedEnum` | feeds `lib/feeds.ts` (`FeedState`; `feedProblem` for `Refused`/`Offline`; the hub's link generation fences a replaced `EventSource`); resources `lib/resource.ts` (`ResourceState`) |
| UI islands | `@ilha/model` `defineApp`, inputs via `islandProps` | create wizard `lib/apps/create-machine.ts`; app detail `lib/app-detail/*.machine.ts` (tab/panel/settings section in `route.machine.ts`), `lifecycle.ts`; D1 grid `lib/storage/d1/{selection,editor-machine,query,search}.ts`; R2 `lib/storage/r2/{folder,write,body}.ts`; PRs `lib/prs/{status,mutation,composer,new-pr}.ts`; login `lib/auth/login-panel.tsx`, gate `lib/auth/gate.ts`, onboarding tour `lib/auth/onboarding.machine.ts` (`TourState` TaggedEnum + `tourTransition`); account `lib/account/{settings.machine,api-key.machine}.ts` |
| Code mode | TaggedEnum + `step` per concern | `lib/source/{ref-view,pane-view,operations,commit-target,row-view,naming-state}.ts`, `lib/forge/{picker-state,load}.ts`; the edits themselves are `lib/source/session.ts`'s maps (base tree, buffers, deletes, moves), not a lifecycle |
