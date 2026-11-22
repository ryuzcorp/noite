# Runner (`apps/runner`)

Read before changing Rust code or the runner↔UI boundary.

## ryu dialect and the build

**Runner is the "ryu" dialect** — proc-macro Rust (`impl`, `let … else`, `anyhow::`, `tracing!`, `format!`, `pub async fn`). The lens ryu analyzer accepts a **superset** of what cargo compiles — several builds shipped broken despite "Rust clean". After any change under `apps/runner/src/` run: `cd apps/runner && ~/.cargo/bin/cargo fmt && ~/.cargo/bin/cargo build --release` (cargo lives there, **not** on PATH). The crate is rustfmt-clean and CI's `rust` job runs `cargo fmt --check`, so run `cargo fmt` on the whole crate. Zero errors/warnings = done.

## Style

- Positional `format!("...{}")`; prefer `let … else` over `?` in expressions; untyped closures in iterator chains (`.filter(|a| …)`; serde `rename_all = "camelCase"` for JSON.

## Runner REST responses (the `runnerFetch` contract)

The runner returns **raw JSON objects, never a `{ body }` envelope**. `GET /v1/apps/{id}` → `{"id":…,"slug":…}`; `git-remote`, `{tree,blob,diff}`, `metrics|spans` all follow the same direct shape. Do not unwrap `.body` — that yields `undefined`, and the calling action throws an unmapped error the client shows as the generic "Internal error" (a classic silent regression when refactoring for lint). `runnerFetch<T>` casts the parsed JSON straight to `T`.

## Schema

Its SQLite shape lives in two idempotent files — `apps/runner/schema.sql` (main DB) and `apps/runner/schema.metrics.sql` (the ATTACHed `metrics` DB) — with installs upgraded by the numbered steps in `schema_version.rs` (see [SPEC: Runner schema evolution](../../SPEC.md#runner-schema-evolution)). Do not reintroduce `apps/runner/migrations/` or `sqlx::migrate!`.
