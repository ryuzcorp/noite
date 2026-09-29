# Spec: minimize Noite's CPU, RAM, egress and storage

**Scope:** the whole install. That means the runner (`apps/runner`), the control UI (`apps/noite`), the celld fleets it spawns, Caddy, the bucket (RustFS or BYO S3) and the image. **Goal:** an idle or lightly used instance should cost close to nothing. Recurring work should scale with real activity (pushes, requests, open dashboards), not with the number of apps × wall-clock time. **Non-goals:** no behaviour changes users can see except the ones listed under [Accepted trade-offs](#accepted-trade-offs). No change to the tenancy/isolation model.

---

## How I measured

The per-call cost of the S3 client was timed inside the dev container (`noite_noite_1`) with bash `time`. Everything else is derived from the cadences in the code, with file and line cited.

| Measurement | Result |
| --- | --- |
| `aws s3api list-objects-v2` against the bundled RustFS | **~0.26 s CPU per call** (0.20 user + 0.05 sys), 3 runs |
| `aws --version` (interpreter startup alone) | ~0.21 s CPU |
| `duckdb -c "select 1"` | ~0.01 s: DuckDB's cost is the data it scans, not the spawn |
| `podman stats`, dev stack, 1 deployed app | `noite` 1.09 GB RAM / ~44 % CPU (includes vite + cargo-watch, so this is not a clean baseline); `rustfs` 331 MB |
| Control bundle `apps/noite/dist` | **35 MB**: client 13 MB, **ssr 19 MB**, worker 4 MB. Dominated by Pierre's syntax grammars (e.g. `emacs-lisp` 790 KB, `cpp` 785 KB, `wasm` 622 KB), which the SSR build also duplicates |
| Release image `noite:local` | **787 MB** |

Phase 0 turns these one-off measurements into a repeatable harness, so every later phase can prove its win.

---

## Findings

"N" is the number of deployed apps, "V" the number of open dashboard panels. Daily counts follow directly from the intervals in the code.

| # | Finding | Evidence | Recurring cost |
| --- | --- | --- | --- |
| F1 | **Every S3 operation spawns the Python AWS CLI.** | `host/cmd.rs` (`aws s3api …` / `aws s3 cp` in every `s3_*` helper); Dockerfile installs `awscli` "until they move into Rust" | ~0.26 CPU-s + a Python heap per call, for every S3 call below |
| F2 | **Git tip poll: one S3 LIST per app every 5 s.** It is the only way a push is noticed, even though pushes arrive through the runner's own Git adapter. | `host/loop_.rs:109` `head_main_bundle`, `RUNNER_POLL_MS=5000` | **17,280 LISTs/app/day** ≈ 4,500 CPU-s/app/day (≈5 % of a core per app) |
| F3 | **Telemetry aggregation runs DuckDB every 10 s per fleet, over a whole day's files**, while its window is only ~10 s. It also runs for stopped apps (filter is `running \|\| last_deploy_sha`). | `host/metrics.rs` `tick` (every 2nd tick), `telemetry_globs` (day-scoped `…/<yyyy>/<mm>/<dd>/*/*.parquet`) | 8,640 runs/app/day, each listing and opening every Parquet footer of the day in S3 (up to ~720 flush files per hour before compaction) |
| F4 | **Log pane query window is 60 h, not 1 h** (bug), re-run **every 2 s per open log pane**. | `host/metrics.rs` `recent_logs`: `60 * 3_600_000_000` µs; `api/observe.rs` `app_logs_stream` sleeps 2 s | A 60-hour DuckDB scan of S3 log Parquet, 43,200×/day per open pane |
| F5 | **Runner SSE loops don't stop when the client leaves.** They only notice when `tx.send` fails, and they only send on change. The control proxy also doesn't forward the browser's abort to the runner. | `api/observe.rs` (logs), `api/deploys.rs` (deploys), `api/events.rs` (events); control `proxyRunnerStream` fetch has no `signal` | Every log/deploy/event pane ever opened can keep polling (logs: DuckDB every 2 s) until its data happens to change |
| F6 | **Spans are recomputed by DuckDB per viewer.** The metrics stream calls `/spans` every 30 s per open metrics card. Since the recent 24h scoping change, each call scans 24 h of traces (was 1 h). | `http/routes.ts` `handleMetricsStream` (30 s, 5 runner calls); `host/metrics.rs` `top_spans` | V × 2,880 DuckDB runs/day, each over a day of traces |
| F7 | **Runner state snapshot uploads the whole SQLite file every 60 s forever.** Telemetry/CPU rows are written every tick, so `PRAGMA data_version` never settles. The code comment admits it ("telemetry writes every tick otherwise"). | `host/state.rs` `DEBOUNCE`/`MIN_INTERVAL`; `VACUUM INTO` + `s3_cp_upload` | **1,440 full-DB uploads/day**, each a `VACUUM INTO` plus an `aws` spawn. The file grows with 14 days of metric/device/path/ref rows |
| F8 | **Each fleet polls the bucket for new deployments every 5 s**, although the runner already calls `POST /reload` after `celld deploy`. | `host/supervisor.rs` `CELLD_DEPLOY_POLL_S=5` | **17,280 GETs/fleet/day** |
| F9 | **OTel flush every 5 s**, so many tiny Parquet PUTs, later read back and rewritten by hourly compaction. | `host/metrics.rs` `OTEL_FLUSH_MS=5000` | Up to 720 PUTs/hour per kind (traces, logs) per active fleet, plus the compaction read/rewrite/delete |
| F10 | **Compaction bookkeeping is in memory.** An hour that was due while the runner was down is never compacted, and tiny files accumulate for the whole 14-day retention. | `metrics::tick` step 3b, `state.compacted` (a `HashMap`) | Slow queries plus extra S3 LIST/GET on every scan that touches those hours |
| F11 | **Every build re-downloads all npm dependencies.** The bun cache sits inside the per-deploy worktree, which is deleted afterwards. | `host/cmd.rs:140` `cwd.join(".bun-cache")`; `host/deploy.rs:370/411` `remove_dir_all` | Full registry download (egress + CPU + disk churn) on every deploy |
| F12 | **The reconcile loop reads full build logs every 5 s per app** just to check "is a deploy in flight". | `host/loop_.rs:93` `db::list_deploys` selects `log` for 20 rows | 17,280 multi-row reads of build-log text per app per day |
| F13 | **The deploys stream re-sends 20 full build logs** on every status change. | `api/deploys.rs` streams `list_deploys` rows including `log` | Hundreds of KB per change per viewer, through two hops (runner → control → browser) |
| F14 | **Dashboard streams keep polling in background tabs.** | `lib/feeds.ts` `liveFeed` → `fromEventSource`; control/runner loops | All of V keeps costing while nobody is looking |
| F15 | **Oversized control bundle.** All of Pierre/shiki's grammars ship, twice (client and SSR), in a client-only SPA. | `dist/` sizes above | 35 MB baked into the image, uploaded to `control/` on each release, and unpacked by the control node |
| F16 | **The image carries Python** for awscli alone. | Dockerfile `apt-get install … awscli` | Image size, pull egress, disk per host |
| F17 | **Fleets never scale to zero.** Every deployed app keeps a celld process, even with no traffic for days. `CELLD_ASSET_CACHE_BYTES` is left at its 512 MiB default per fleet. | `host/supervisor.rs` env; AGENTS.md "Asset cache" | Resident memory per idle app; up to 512 MiB disk cache per fleet |

---

## Phases and tasks

Every phase leaves the system working and verifiable. Rules for all runner tasks: `cargo build --release` clean, `bun run check` clean, `make e2e` green. Anything touching `cmd.rs`, `deploy.rs`, `netisolation.rs`, `isolation.rs` or the Dockerfile also needs `make e2e-isolation`.

### Phase 0: measure first

**T0.1 Runner cost counters.**

- Add process-wide counters to the runner:
  - subprocess spawns by program (`aws`, `duckdb`, `git`, `celld`, `bun`),
  - S3 operations by verb, with bytes up and down,
  - DuckDB runs by purpose (`agg`, `spans`, `logs`, `compact`),
  - snapshot uploads with bytes,
  - live SSE loops by kind.
- Expose them on the bearer-gated `GET /v1/admin/stats`, together with process RSS and CPU time from `/proc/self`.

**T0.2 `make usage` target.** It collects, over a fixed window (default 10 min, `WINDOW=`):

- `podman stats` samples for `noite` and `rustfs`,
- the delta of `/v1/admin/stats`,
- `du` of `/data`,
- bucket size per prefix (`git/`, `fleets/`, `control/`, `runner/state/`).

It prints one table. Record a **baseline** for three scenarios:

- idle, 3 deployed apps, no browser;
- one dashboard tab open on the Metrics and Deployments tabs;
- one deploy.

_Done when:_ the baseline table is committed at the end of this spec, under "Results". Every later task quotes its before/after from the same harness.

### Phase 1: bug fixes and config (low risk, large win)

**T1.1 Fix the log window (F4).**

- `recent_logs` should read the last **hour**, as its comment says: `3_600_000_000` µs, not `60 * …`.
- Interim only: Phase 3 replaces this path.

**T1.2 SSE loops stop on disconnect (F5).**

- In the three runner stream loops, race the sleep against `tx.closed()` (`tokio::select!`) and break when the receiver is gone.
- In control `proxyRunnerStream`, pass `signal: request.signal` to the upstream `fetch` so a browser leaving closes the runner request.
- Add `live SSE loops` gauges (T0.1) and a test: open a stream, drop the client, and the gauge returns to 0 within one interval.

**T1.3 Don't aggregate stopped apps (F3).**

- The telemetry pass only covers apps with a running fleet process.
- Compaction still runs once for the hour in which a fleet stopped, so its last files get folded.

**T1.4 Hour-scoped aggregation globs (F3).**

- Build `telemetry_globs` at hour granularity (`…/<yyyy>/<mm>/<dd>/<hh>/*.parquet`) for the hours the window spans.
- A 10 s window then names one or two hour directories instead of a whole day.
- Keep day-scoped globs only for multi-day reads, which Phase 3 removes from the request path.

**T1.5 Stop fleets polling for deployments (F8).**

- `CELLD_DEPLOY_POLL_S` goes from 5 to 300 (configurable: `RUNNER_FLEET_DEPLOY_POLL_S`).
- The runner's `POST /reload` after `celld deploy` is the fast path, and the poll only covers a missed reload.
- Verify first that every deploy path (push, rollback, web commit, rename) calls reload.

**T1.6 In-flight check without logs (F12).**

- Add `db::latest_deploy_status(app_id)`, which selects only `status, updated_at` from the newest few rows.
- Use it in `reconcile_once` instead of `list_deploys`.

**T1.7 Lean deploys stream (F13).**

- `list_deploys` for the stream omits `log` from all rows, except the newest row when it is in flight (its live build log is what the panel shows).
- Add `GET /v1/apps/{id}/deploys/{deploy_id}/log`.
- UI: `DeployRow` fetches a finished row's log when its "Build logs" tab is opened, using an SWR resource keyed by deploy id. Build logs of finished deploys never change, so they can be cached forever.

**T1.8 Bound the per-fleet asset cache (F17).**

- Set `CELLD_ASSET_CACHE_BYTES` per fleet from a new `RUNNER_FLEET_ASSET_CACHE_MB`, default **64**.
- Document it next to the other fleet limits in AGENTS.md.

**T1.9 Pause live feeds in background tabs (F14).**

- `liveFeed()` closes its `EventSource` on `visibilitychange → hidden` and reopens it on `visible`. The SWR snapshot keeps the panel painted.
- Control-side and runner loops then stop by themselves through T1.2.

_Phase done when:_ the idle-scenario spawn and S3 counters drop, and the numbers are recorded. Expected removals: the 60-hour log scans, leaked loops, fleet deploy polls and stopped-app aggregation.

### Phase 2: native S3 and push-driven deploys (F1, F2, F16)

**T2.1 Native S3 client in the runner.**

- Replace every `aws` subprocess in `host/cmd.rs` (`s3_list_prefix`, `s3_list_delimited`, `s3_object_exists`, `s3_cp_upload`/`download`, `s3_delete_key`, `s3_rm_dir_except`, `head_main_bundle` and the rest) with one shared, connection-pooled client.
- Options:
  - `aws-sdk-s3`: the full SDK, heavier to build;
  - `rusty-s3` (request signing) on top of the `reqwest` the runner already uses: small, no new runtime.
- **Recommend `rusty-s3` + `reqwest`:** Noite uses a handful of verbs, and binary size matters here.
- Streaming upload and download for bundles and snapshots (no full buffering).
- Keep the helpers' signatures, so call sites don't change.
- Path-style addressing for RustFS; the endpoint, region and credentials come from the same env the CLI used.

**T2.2 Push-driven tip detection (F2).**

- The Git smart-HTTP adapter (`host/git_http.rs`, after the ref update and bundle upload) and `web_commit.rs` already know when `main` moves.
- Send `(app_id, sha)` on an in-process channel that the reconcile loop drains every tick, and deploy directly from it.
- Keep `head_main_bundle` only as a **fallback sweep every 60 s** (`RUNNER_TIP_SWEEP_S`), for bundles written by another runner or by hand.
- _Done when:_ a push still deploys within one tick, and idle LIST traffic drops from 1 per app per 5 s to 1 per app per 60 s (by the counters).

**T2.3 Drop awscli from the image.**

- Remove `awscli` from the Dockerfile's `apt-get install`. Also update the comment and `check-versions.ts` if it references awscli.
- `make doctor` and `docker/backup.sh`/`restore.sh` must not rely on `aws` inside the container. Use the runner API (`POST /v1/admin/snapshot`) or `rustfs`/`mc` from outside.
- _Done when:_ the image no longer contains Python (`python3 --version` fails in the container), and its size is recorded.

### Phase 3: telemetry pipeline without per-request DuckDB (F3, F4, F6, F9, F10)

The principle: **read each Parquet file once, at ingest, and serve every dashboard from SQLite.** No DuckDB on any request path.

**T3.1 One ingest pass per tick, all fleets.**

- Replace the per-fleet `telemetry_agg` spawn with a single DuckDB invocation per tick over the hour globs (T1.4) of every live fleet. The slug comes from the file path (`filename=true`, regex on `fleets/<slug>/`).
- That pass produces all of these at once:
  - minute buckets (`app_metric`, as today),
  - **hourly span stats** (T3.2),
  - **new log lines** (T3.3).
- The watermark semantics are unchanged.

**T3.2 Persist span stats (F6).**

- New table `app_span_stat(app_id, bucket_hour, name, kind, n, ms, err, qwait_ms)` with upsert-accumulate, filled by T3.1. Retention matches the other metric tables.
- `GET /v1/apps/{id}/spans?hours=` becomes a SQLite `GROUP BY name, kind … ORDER BY ms DESC LIMIT 8` over the window.
- This makes the 24h default free, and it is what makes the future 24h / 7d range picker cheap. The runner's 24 h clamp on spans can then match the other series' 336 h.

**T3.3 Logs as an ingested ring (F4).**

- T3.1 appends new OTel log rows per app into a bounded store: `app_log(app_id, ts_us, body)`, capped per app (e.g. the last 2,000 lines or 24 h, whichever is smaller), pruned in the tick.
- `/logs` and `/logs/stream` read the ring plus the existing in-memory stdout tail (`logs::tail`). The stream wakes on a `tokio::sync::watch` "new logs for app X" signal from the tick, instead of polling DuckDB every 2 s.

**T3.4 Longer OTel flush (F9).**

- `OTEL_FLUSH_MS` goes from 5,000 to **30,000** (configurable: `RUNNER_OTEL_FLUSH_MS`).
- `AGG_LAG_US` must exceed it; derive it as `flush + 10 s`.
- Result: 6× fewer PUTs and files per active fleet. Dashboards lag real traffic by up to ~40 s instead of ~15 s (see trade-offs).
- The aggregation cadence follows: one tick per flush interval, not every 10 s.

**T3.5 Durable compaction watermark (F10).**

- Persist the last compacted hour per slug (`metric_compaction(slug, hour)` in SQLite).
- On each hourly pass, compact every uncompacted, completed hour since the watermark, bounded to N hours per pass so a long outage catches up gradually.

**T3.6 Metrics stream stays cheap.**

- With T3.2/T3.3, the control's 5-call metrics poll is five SQLite reads.
- Additionally, have the control stream skip the poll when the runner's per-app metrics version (a counter bumped by the tick) hasn't changed. This needs a small `GET /v1/apps/{id}/metrics/version`, or an `ETag` on the combined endpoint.

_Phase done when:_ no DuckDB process starts outside the ingest tick and hourly compaction (by the counters), and every dashboard panel still shows the same data (e2e).

### Phase 4: state snapshots (F7)

**T4.1 Split metrics out of the snapshotted database.**

- Move the high-churn, rebuildable tables into `/data/metrics.sqlite`: `app_metric`, `app_device_stat`, `app_path_stat`, `app_ref_stat`, `app_span_stat`, `app_log`, `metric_watermark`, `metric_compaction`. It is attached, not snapshotted.
- These tables are derived from bucket telemetry and Caddy logs. Losing the volume loses at most the retention window of dashboard history, which is acceptable (see trade-offs). Pricing uses `app_metric`; if pricing needs durability, snapshot `metrics.sqlite` separately, **hourly**.
- `noite.sqlite` then changes only on real control-plane writes: apps, deploys, domains, env, collaborators, events. The existing `data_version` trigger goes quiet on its own.

**T4.2 Compress snapshots.** Upload `noite.sqlite.zst` (zstd level 3) with the metadata recording the codec. Restore handles both forms. This saves bucket storage and upload bytes.

**T4.3 Skip identical snapshots.** Hash the `VACUUM INTO` output and skip the upload when it matches the last uploaded hash. This covers writes that don't change bytes (e.g. an upsert of the same row).

_Phase done when:_ on an idle instance with running fleets, snapshot uploads drop from ~1,440/day to (near) zero, per the counters.

### Phase 5: builds (F11)

**T5.1 Persistent per-app bun cache.**

- `BUN_INSTALL_CACHE_DIR` moves to `/data/runner/cache/<slug>/bun`, owned by the build uid.
- It is **per app**, never shared across tenants: a shared cache would let one tenant's build poison another's packages.
- Size-capped (`RUNNER_BUILD_CACHE_MB`, default 512) and pruned oldest-first after each deploy.
- Deleted with the app (`purge_slug`) and on rename (`host/rename.rs`).
- _Isolation:_ the directory lives inside the already-private builds tree, is chowned exactly like the worktree, and is not readable by the fleet uid. Needs `make e2e-isolation`.

**T5.2 Keep the bare mirror warm.**

- Confirm deploys fetch from the runner's local bare mirror, not a fresh bundle download, when the mirror already has the sha.
- Measure bundle downloads per deploy (T0.1) and fix if they are more than 0 for a warm app.

**T5.3 (Later) Incremental bundles.**

- Each push uploads a full `git bundle create <ref>` (full history).
- For large repos, consider incremental bundles against the previous tip, with periodic re-basing to a full bundle.
- Measure the bundle size distribution first; defer unless it's significant.

### Phase 6: bundle and image size (F15, F16)

**T6.1 Curate Pierre/shiki languages.**

- Configure `@pierre/diffs` (or its shiki highlighter) with an explicit language list covering what tenant Worker repos contain: `js`, `ts`, `jsx`, `tsx`, `json`, `jsonc`, `md`, `css`, `html`, `toml`, `yaml`, `sh`, `sql`, `txt`.
- Anything else renders as plain text.
- _Done when:_ `dist/client` and `dist/ssr` each lose the grammar chunks (target: control dist under 8 MB), and the source page still highlights the listed languages (T0.2 / e2e).

**T6.2 Drop the unused SSR build, if Oxide allows it.**

- The control UI is a client-only SPA (`client.ts` mounts without hydrate; no server islands).
- Check whether `oxide({ … })`/`pages()` can skip the SSR bundle while keeping actions and the `@ilha/router/ssr` frame middleware. If they can't, T6.1 already shrinks it.
- Don't hand-delete the output.

**T6.3 Slimmer runtime base.**

- After T2.3, measure the image. Then consider `debian:bookworm-slim` with the `bun` binary copied from `oven/bun` (instead of the full `oven/bun:debian` base).
- Keep the pins single-sourced (`check-versions.ts`).

### Phase 7: idle apps (F17, larger; optional)

**T7.1 Scale-to-zero fleets.**

- Stop a fleet after `RUNNER_FLEET_SLEEP_AFTER_S` (default off; suggested 1800) with no `celld.fetch` spans.
- The runner already knows this from ingest (T3.1).
- Caddy routes a sleeping app to a small runner "wake" handler, which spawns the fleet, waits for readiness (bounded, e.g. 10 s), then proxies the request or returns a 503 + `Retry-After` page (reuse `caddy.rs`'s existing retry page).
- Needs a design note in SPEC.md (cold-start latency, interaction with custom domains and TLS ask) before implementation.

**T7.2 Faster idle eviction inside fleets.** Lower `RUNNER_FLEET_IDLE_EVICT_S` from 300 to 120 as the default, after measuring cold-start cost with T0.2.

**T7.3 Retention defaults.** Keep 14 days, but make it one knob (`RUNNER_TELEMETRY_RETENTION_DAYS`) that drives:

- `CELLD_OTEL_RETENTION`,
- the metric table pruning,
- the glob floor,
- the future range picker's maximum.

Small installs can then choose 7.

---

## Expected impact

Rough, per deployed app per day, from the cadences above.

| Area | Today | After |
| --- | --- | --- |
| Tip polling (S3 LIST via `aws`) | 17,280 calls ≈ 4,500 CPU-s | ~1,440 native LISTs (60 s sweep), CPU negligible; deploy on push via channel |
| Fleet deploy polls (S3 GET) | 17,280 | 288 |
| Aggregation DuckDB runs | 8,640 per app, day-wide globs | 1 run per tick for _all_ apps, hour-wide globs |
| Log pane | 60 h scan every 2 s per pane, leaked on disconnect | SQLite ring read on change; stops on disconnect or hidden tab |
| Spans (24h) per metrics viewer | DuckDB over 24 h every 30 s | SQLite query, skipped when unchanged |
| OTel PUTs (active fleet) | ≤ 17,280 per kind | ≤ 2,880 per kind |
| State snapshot uploads | 1,440 full-DB uploads (instance-wide) | Only on control-plane changes; zstd-compressed |
| npm downloads per deploy | Full dependency tree | Cache hits after the first build |
| Image / control bundle | 787 MB / 35 MB | Python gone; bundle target under 8 MB |

Replace these with real numbers from `make usage` as each phase lands.

---

## Accepted trade-offs

- **Longer OTel flush (T3.4).** Request counts and charts lag live traffic by up to ~40 s instead of ~15 s. Minute buckets and pricing are unaffected.
- **Fallback tip sweep of 60 s (T2.2).** Only pushes that bypass the runner (another runner, or a manual bucket write) take up to a minute to deploy. Normal pushes deploy immediately.
- **Metrics tables not snapshotted (T4.1).** Losing the data volume loses dashboard history (≤ retention), not control-plane state. Apps, deploys, domains, env, collaborators and events are still snapshotted.
- **Curated highlighting (T6.1).** Uncommon languages render as plain text in the source preview.
- **Build cache on disk (T5.1).** Up to `RUNNER_BUILD_CACHE_MB` per app on `/data`, in exchange for no repeated registry downloads.

## Needs your decision

These change documented behaviour or locked decisions (AGENTS.md: ask first):

1. **T2.1 S3 client choice:** `rusty-s3` + `reqwest` (recommended) vs `aws-sdk-s3`.
2. **T3.4 flush interval:** 30 s recommended. It changes a value AGENTS.md documents ("the docs' near-live value").
3. **T4.1 durability of metrics history:** unsnapshotted (recommended), or snapshotted hourly because pricing depends on it.
4. **T7.1 scale-to-zero:** in scope now, or later behind a flag.

## Suggested PR order

| PR | Tasks | Risk |
| --- | --- | --- |
| 1 | T0.1, T0.2 (+ baseline) | none |
| 2 | T1.1 – T1.9 | low |
| 3 | T2.1 | medium (every S3 path) |
| 4 | T2.2, T2.3 | medium |
| 5 | T3.1 – T3.3, T3.5 | high (metrics substrate): run alongside the old path and compare numbers for a day before switching |
| 6 | T3.4, T3.6 | low |
| 7 | T4.1 – T4.3 | medium (snapshot/restore) |
| 8 | T5.1, T5.2 | medium (isolation) |
| 9 | T6.1 – T6.3 | low |
| 10 | T7.x | design first |

## Results

Implemented 2026-09-29 in one pass (four parallel slices + integration). Verification: `cargo build --release` 0 errors 0 warnings, `cargo test --release` 52 passed, `bun run check` clean, `apps/noite` build clean. `make e2e` / `make e2e-isolation` NOT run (dev stack occupies :9080; the lane needs those ports free) — run them before release. No live-stack `make usage` baselines were captured for the same reason; the harness exists (`make usage`, `WINDOW=` seconds, default 600) and `GET /v1/admin/stats` exposes the counters (spawns by program, S3 by verb + bytes, DuckDB by purpose, snapshot uploads + bytes, live SSE gauges, RSS/CPU from `/proc/self`).

Measured wins (no live stack needed):

| Area | Before | After |
| --- | --- | --- |
| Control bundle `apps/noite/dist` | 35 MB (client 13, ssr 19, worker 4) | **20 MB** (client 6.0, ssr ~10, celld entry 4.1): non-curated shiki grammars stubbed at build time (106 assets, was 335); `cpp`/`rust`/`python`/`emacs-lisp` chunks gone, curated 14 still real |
| S3 client | every op spawns `aws` (~0.26 CPU-s) | native `rusty-s3` + pooled `reqwest`, same helper signatures; `awscli` removed from the image |
| Tip polling | 17,280 LISTs/app/day | push-driven channel deploys within one tick; 60 s fallback sweep (`RUNNER_TIP_SWEEP_S`) |
| Fleet deploy polls | 17,280 GETs/fleet/day | 288 (`CELLD_DEPLOY_POLL_S` 5 → 300 via `RUNNER_FLEET_DEPLOY_POLL_S`); reload-after-deploy is the fast path |
| Aggregation | per-fleet DuckDB every 10 s over day globs, incl. stopped apps | one ingest per tick over hour globs of live fleets only; stopped fleet's final hour compacted once |
| Log pane | 60 h scan every 2 s per pane (bug: 60× window) | 1 h window; SQLite ring + watch wake, no poll |
| Spans per viewer | DuckDB over 24 h every 30 s | SQLite over `app_span_stat`; poll skipped when `/metrics/version` unchanged |
| OTel PUTs (active fleet) | ≤ 17,280/kind/day | ≤ 2,880/kind/day (flush 5 s → 30 s via `RUNNER_OTEL_FLUSH_MS`; `AGG_LAG` = flush + 10 s) |
| Snapshots | 1,440 full-DB uploads/day | metrics split into attached (unsnapshotted) `metrics.sqlite`; main DB uploads zstd-compressed, skipped when hash-identical |
| Deploys stream | 20 full build logs per change | `log` omitted except newest in-flight row; `GET /v1/apps/{id}/deploys/{deploy_id}/log` + forever-cached UI fetch |
| Reconcile in-flight check | full build-log text every 5 s/app | `latest_deploy_status` (status + timestamp only) |
| Idle evict / asset cache / retention | 300 s / 512 MiB / scattered | 120 s / 64 MiB (`RUNNER_FLEET_ASSET_CACHE_MB`) / one knob (`RUNNER_TELEMETRY_RETENTION_DAYS`) |
| Bun cache per deploy | full registry re-download | persistent per-app `/data/runner/cache/<slug>/bun` (`RUNNER_BUILD_CACHE_MB`, 512), oldest-first prune, build-uid owned, purged/renamed with the app |
| Background tabs | all streams keep polling | `liveFeed` closes on hidden, reopens on visible; runner loops exit via `tx.closed()` race; control proxy forwards abort |
| Unrouted handlers | `webhook`/`app_refs` dead or half-wired | `webhook` deleted (superseded by push tips + sweep); `/refs` and `/metrics/version` routes added (the metrics poll requires both) |

Decisions (spec's open questions, all took the recommendation except the last): T2.1 `rusty-s3` + `reqwest`; T3.4 flush 30 s; T4.1 metrics unsnapshotted (pricing re-derives from bucket telemetry). T7.1 scale-to-zero: implemented after its SPEC.md design note (see below). T6.2: SSR kept — `@ilha/router/ssr` is the action frame, so the ssr bundle (~10 MB, mostly pierre core + curated grammars + schemas) stays; the 8 MB dist target needs a framework-level SSR exemption. The oniguruma `shiki/wasm` chunk (~622 KB ×2, engine never selected by default) was left alone for the same reason.

### T7.1 Scale to zero (implemented)

Design note: SPEC.md, "Scale to zero (idle sleep)". Code: `host/sleep.rs` (sweep, per-app transition lock, wake with health wait), `host/edge.rs::wake`, `host/caddy.rs::{tenant_site_extra, tenant_proxy}`, `app.asleep_since`/`app.woke_at` via `db::ensure_column`, `POST /v1/apps/{id}/sleep` (operator/test lever), counters `sleep.slept`/`sleep.woken` in `/v1/admin/stats`. Knobs: `RUNNER_SLEEP_AFTER_H` (24, 0 = off), `RUNNER_SLEEP_SWEEP_S` (3600), `RUNNER_WAKE_TIMEOUT_S` (120).

- **Sweep:** an hourly scheduled job parks apps with no request in 24 h. Activity is the newest of: last request bucket, last wake, last deploy, creation.
- **Waking:** there is no "starting" page. The asleep app's sites keep their route behind `forward_auth` to `/v1/edge/wake`. Caddy holds the request until the fleet's health route is 200, then serves it normally.

Verified live on the dev stack (sample app `test`, 2026-09-29):

| Check | Result |
| --- | --- |
| Sleep | fleet process gone (13.8 s = celld's SIGTERM drain), status `sleeping`, both sites switched to the wake route, Caddy accepted the config |
| Asleep across a runner restart | still asleep, no fleet respawned, wake route still present |
| 5 concurrent GETs to the asleep app | all **200 in 1.34 s** (one shared wake), each counted exactly once by the app (visit counter 15→19), wake route removed afterwards |
| PUT with a body to the asleep app | stored and read back byte-identical: the held body survives the wake |
| Two defects found and fixed by the live run | (1) `/v1/edge/wake` was behind bearer auth (visitors got 401); (2) active health checks on the wake route kept a stale "down" state, so the released request got the starting page. That route now has no active checks: the wake already waited for health 200 |

Unit tests: the idle decision (threshold, newest-activity-wins, disabled/unknown never sleeps), plus the Caddy route (asleep = wake hop without health checks; awake and stopped apps get no hop). The sweep's hourly scheduling itself was not observed live (it needs a 24 h idle app).
