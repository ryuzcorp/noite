//! The runner database's schema stamp and forward-migration runner.
//!
//! `schema.sql` is the complete shape of a fresh database, applied on every
//! boot. Alpha databases stamped 1..16 predate the 2026-11-09 compaction and
//! are refused, not migrated: they predate the compaction and cannot be reshaped in place. This build's
//! baseline is [`SCHEMA_VERSION`]; a shape change appends a `(version, sql)`
//! above the baseline and bumps the constant, and a database stamped below it
//! is migrated forward. A database stamped by a newer build is refused.

use anyhow::{bail, Context};
use sqlx::SqliteConnection;

/// First stamp of the compacted schema. Stamps below it are pre-compaction
/// alphas and are refused.
pub const FIRST_COMPACTED_VERSION: i64 = 100;

/// Version a database has after every migration ran.
pub const SCHEMA_VERSION: i64 = FIRST_COMPACTED_VERSION + 7;

/// One upgrade step: the statements that take a database from `version - 1`
/// to `version`. Empty at the compacted baseline; append above it to change
/// the shape of an existing install.
pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// Steps above the baseline, ascending and contiguous.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        // 101: why a deploy ran (`DeployIntent`). Every existing row is a
        // plain deploy — the column's default says so — and the API serves
        // the field from then on.
        version: FIRST_COMPACTED_VERSION + 1,
        sql: "ALTER TABLE main.deploy ADD COLUMN intent TEXT NOT NULL DEFAULT 'deploy';",
    },
    Migration {
        // 102: the automatic-deploy budget reads one target's newest rows on
        // every annotate and before every automatic deploy. Without this
        // index that is a scan + sort of the app's whole history.
        version: FIRST_COMPACTED_VERSION + 2,
        sql: "CREATE INDEX IF NOT EXISTS main.idx_deploy_target_created \
              ON deploy(app_id, environment_id, created_at);",
    },
    Migration {
        // 103: who asked for a deploy, when the caller could say. NULL on
        // every existing row and on the automatic push/tip pipeline, so the
        // column reads as "nobody (automatic)".
        version: FIRST_COMPACTED_VERSION + 3,
        sql: "ALTER TABLE main.deploy ADD COLUMN actor TEXT;",
    },
    Migration {
        // 104: how a machine signed a pull request, a comment and a review.
        // `keyActor` writes '<user> via key <name>' so the PR pages show a
        // bot's work as one; NULL keeps the account name D1 resolves.
        version: FIRST_COMPACTED_VERSION + 4,
        sql: "ALTER TABLE main.pull_request ADD COLUMN author_label TEXT; \
              ALTER TABLE main.pr_comment ADD COLUMN author_label TEXT; \
              ALTER TABLE main.pr_review ADD COLUMN author_label TEXT;",
    },
    Migration {
        // 105: a finished deploy's own one-line error: the history paints the
        // reason in the deploy's row instead of repeating it in the app's
        // `last_error`, and the row's `updated_at` (its last write, since a
        // terminal row never changes again) is its finish stamp. Rows
        // finished before this step keep their history; they have no row
        // error, and their duration reads from `updated_at` like a new one.
        version: FIRST_COMPACTED_VERSION + 5,
        sql: "ALTER TABLE main.deploy ADD COLUMN error TEXT;",
    },
    Migration {
        // 106: the durable record of a deleted app's pending wipe. Before it,
        // a delete dropped the row first and kept the wipe only in memory, so
        // a crash, an S3 failure or a wipe stopped by a re-create that then
        // aborted left the tenant's git/D1/DO/env data in the bucket with
        // nothing to resume it. Rows are written in the same transaction as
        // the app DELETE (`db::delete_app`) and cleared once the prefixes are
        // empty (`host::purge::resume_pending` and the wipe's own callers).
        //
        // `build_uid` is the deleted app's per-app build uid, which the wipe
        // still owns: the row delete frees the uid at once, but its
        // `builds/<slug>` and `cache/<slug>` trees survive, owned by that
        // uid, until the wipe removes them. Handing the uid to a new app in
        // that window ran its build with the departed tenant's files
        // readable (merge-group e2e, 2026-11-12: a hostile build read a
        // sibling's package caches). `delete_app` writes it with the
        // tombstone, `db::alloc::ensure_app_build_uid` reserves it, and a
        // NULL says the app never had one.
        version: FIRST_COMPACTED_VERSION + 6,
        sql: "CREATE TABLE IF NOT EXISTS main.app_purge (\
                app_id TEXT PRIMARY KEY NOT NULL, \
                slug TEXT NOT NULL, \
                created_at TEXT NOT NULL, \
                build_uid INTEGER\
              ); \
              CREATE INDEX IF NOT EXISTS main.idx_app_purge_slug \
              ON app_purge(slug);",
    },
    Migration {
        // 107: the origin sha an import or GitHub sync last synced to. Imports
        // (and syncs) write it; the sync status reads it to count the Noite
        // commits a sync would overwrite. NULL on every existing row: an app
        // imported before this step counts its whole history as local.
        version: FIRST_COMPACTED_VERSION + 7,
        sql: "ALTER TABLE main.app ADD COLUMN last_sync_sha TEXT;",
    },
];

/// What boot must do to bring a database to the latest version.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Run these migrations (possibly none), then `schema.sql`, then stamp.
    Apply(Vec<i64>),
    /// A database from before the compaction: refused, never migrated.
    Legacy { found: i64 },
    /// Stamped newer than this binary: refuse to boot.
    TooNew { found: i64 },
}

/// `stored` is `user_version`; `populated` says the database already has
/// tables. An unstamped database with tables is a pre-versioning alpha.
pub fn plan(stored: i64, populated: bool, latest: i64, steps: &[Migration]) -> Plan {
    if stored > latest {
        return Plan::TooNew { found: stored };
    }
    if stored == 0 {
        return if populated {
            Plan::Legacy { found: 0 }
        } else {
            Plan::Apply(Vec::new())
        };
    }
    if stored < FIRST_COMPACTED_VERSION {
        return Plan::Legacy { found: stored };
    }
    Plan::Apply(
        steps
            .iter()
            .map(|m| m.version)
            .filter(|v| *v > stored && *v <= latest)
            .collect(),
    )
}

/// Bring the database to `latest`: migrations first (so `schema.sql`'s
/// indexes find their columns), then the idempotent shape, then the stamp.
/// The caller owns the transaction, so a refusal leaves the file untouched.
pub async fn apply(
    conn: &mut SqliteConnection,
    // Always a compile-time schema (`include_str!` in production, literals
    // in tests): sqlx 0.9 only takes `&'static str` or an audited wrapper.
    schema_sql: &'static str,
    latest: i64,
    steps: &[Migration],
) -> anyhow::Result<()> {
    let stored: i64 = sqlx::query_scalar("PRAGMA main.user_version")
        .fetch_one(&mut *conn)
        .await
        .context("read schema version")?;
    let populated: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'table' AND name = 'app'",
    )
    .fetch_one(&mut *conn)
    .await
    .context("probe database")?;
    let versions = match plan(stored, populated > 0, latest, steps) {
        Plan::Legacy { found } => bail!(
            "refusing to start: the runner database was written before the 2026-11-09 schema \
             compaction (stamp {found}) and cannot be upgraded in place. Back it up, wipe the \
             data volume and install fresh; databases on the compacted baseline upgrade by \
             re-running the installer."
        ),
        Plan::TooNew { found } => bail!(
            "refusing to start: the runner database is schema version {found} but this image \
             only understands up to {latest}. It was written by a newer Noite; run that image \
             again, or restore a backup taken before the upgrade. Downgrades are not supported."
        ),
        Plan::Apply(versions) => versions,
    };
    for version in versions {
        let step = steps
            .iter()
            .find(|m| m.version == version)
            .context("migration list lost a step")?;
        sqlx::raw_sql(step.sql)
            .execute(&mut *conn)
            .await
            .with_context(|| format!("migrate the runner database to schema version {version}"))?;
    }
    sqlx::raw_sql(schema_sql)
        .execute(&mut *conn)
        .await
        .context("apply schema")?;
    // PRAGMA takes no bind parameters; `latest` is a constant integer.
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "PRAGMA main.user_version = {latest}"
    )))
    .execute(&mut *conn)
    .await
    .context("stamp schema version")?;
    if stored != latest {
        tracing::info!(from = stored, to = latest, "runner database schema stamped");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use sqlx::{Connection, SqliteConnection};

    const BASELINE: &str = "CREATE TABLE IF NOT EXISTS app (id TEXT PRIMARY KEY, slug TEXT);";

    async fn memory() -> SqliteConnection {
        SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("memory db")
    }

    async fn version(conn: &mut SqliteConnection) -> i64 {
        sqlx::query_scalar("PRAGMA main.user_version")
            .fetch_one(conn)
            .await
            .expect("user_version")
    }

    #[tokio::test]
    async fn fresh_database_gets_the_shape_and_the_baseline_stamp() {
        let mut conn = memory().await;
        apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect("apply");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);
        let tables: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM main.sqlite_master WHERE name = 'app'")
                .fetch_one(&mut conn)
                .await
                .expect("tables");
        assert_eq!(tables, 1);
    }

    #[tokio::test]
    async fn this_build_reboots_cleanly() {
        let mut conn = memory().await;
        apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect("first boot");
        apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect("second boot");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);
    }

    #[test]
    fn planning() {
        let steps = [Migration {
            version: FIRST_COMPACTED_VERSION + 1,
            sql: "ALTER TABLE app ADD COLUMN note TEXT;",
        }];
        // Fresh: schema.sql builds it, no steps.
        assert_eq!(plan(0, false, SCHEMA_VERSION, &steps), Plan::Apply(vec![]));
        // This baseline: the next step applies.
        assert_eq!(
            plan(
                FIRST_COMPACTED_VERSION,
                true,
                FIRST_COMPACTED_VERSION + 1,
                &steps
            ),
            Plan::Apply(vec![FIRST_COMPACTED_VERSION + 1])
        );
        // A pre-compaction alpha stamp is refused, never migrated.
        assert_eq!(
            plan(16, true, SCHEMA_VERSION, &steps),
            Plan::Legacy { found: 16 }
        );
        // An unstamped database with tables is pre-versioning.
        assert_eq!(
            plan(0, true, SCHEMA_VERSION, &steps),
            Plan::Legacy { found: 0 }
        );
        // A newer build is refused.
        assert_eq!(
            plan(SCHEMA_VERSION + 1, true, SCHEMA_VERSION, &steps),
            Plan::TooNew {
                found: SCHEMA_VERSION + 1
            }
        );
    }

    #[tokio::test]
    async fn a_pre_compaction_alpha_is_refused_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY); PRAGMA main.user_version = 16;")
            .execute(&mut conn)
            .await
            .expect("seed an alpha.27 database");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("stamp 16"), "{text}");
        assert!(text.contains("data volume"), "{text}");
        assert_eq!(version(&mut conn).await, 16);
        let columns: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app')")
            .fetch_one(&mut conn)
            .await
            .expect("columns");
        assert_eq!(columns, 1);
    }

    /// The 106 step adds the durable pending-purge table (with the build uid
    /// the wipe still owns) to a stamped database, so an install that
    /// upgrades mid-delete keeps the record of every wipe it still owes.
    #[tokio::test]
    async fn the_app_purge_step_upgrades_a_stamped_database() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             CREATE TABLE main.deploy (id TEXT PRIMARY KEY, app_id TEXT, environment_id TEXT, \
                                       sha TEXT, status TEXT, intent TEXT, error TEXT, \
                                       created_at TEXT); \
             PRAGMA main.user_version = 105;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a 105 database");
        apply(
            &mut conn,
            "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);",
            SCHEMA_VERSION,
            MIGRATIONS,
        )
        .await
        .expect("migrate forward");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);
        let found: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'table' \
             AND name = 'app_purge'",
        )
        .fetch_one(&mut conn)
        .await
        .expect("table lookup");
        assert_eq!(found, 1);
        let uid_column: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('app_purge') WHERE name = 'build_uid'",
        )
        .fetch_one(&mut conn)
        .await
        .expect("column lookup");
        assert_eq!(uid_column, 1, "the tombstone carries the uid the wipe owns");
    }

    /// The 102 step adds the budget's covering index to a stamped database.
    #[tokio::test]
    async fn the_budget_index_step_upgrades_a_stamped_database() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             CREATE TABLE main.deploy (id TEXT PRIMARY KEY, app_id TEXT, environment_id TEXT, \
                                       sha TEXT, status TEXT, intent TEXT, created_at TEXT); \
             CREATE TABLE main.pull_request (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_comment (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_review (id TEXT PRIMARY KEY NOT NULL); \
             PRAGMA main.user_version = 101;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a 101 database");
        apply(
            &mut conn,
            "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);",
            SCHEMA_VERSION,
            MIGRATIONS,
        )
        .await
        .expect("migrate forward");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);
        let found: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'index' \
             AND name = 'idx_deploy_target_created'",
        )
        .fetch_one(&mut conn)
        .await
        .expect("index lookup");
        assert_eq!(found, 1);
    }

    /// The 101 step is the live one: a database stamped at the previous
    /// baseline gains `deploy.intent`, and every row it already holds reads
    /// `deploy` (the column default), so no backfill is needed.
    #[tokio::test]
    async fn the_intent_step_upgrades_a_stamped_database() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.deploy (id TEXT PRIMARY KEY, app_id TEXT, environment_id TEXT, \
                                      sha TEXT, status TEXT NOT NULL, created_at TEXT); \
             INSERT INTO main.deploy (id, app_id, status) VALUES ('d1', 'a1', 'failed'); \
             CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             CREATE TABLE main.pull_request (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_comment (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_review (id TEXT PRIMARY KEY NOT NULL); \
             PRAGMA main.user_version = 100;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a baseline database");
        apply(
            &mut conn,
            "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);",
            SCHEMA_VERSION,
            MIGRATIONS,
        )
        .await
        .expect("migrate forward");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);
        let intent: String = sqlx::query_scalar("SELECT intent FROM main.deploy WHERE id = 'd1'")
            .fetch_one(&mut conn)
            .await
            .expect("intent column");
        assert_eq!(intent, "deploy");
    }

    /// The 104 step adds `author_label` to the three pull-request tables: a
    /// database from the previous baseline gains the column on each, NULL for
    /// every row it already holds (the UI then keeps the D1 account name).
    #[tokio::test]
    async fn the_author_label_step_upgrades_a_stamped_database() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             CREATE TABLE main.deploy (id TEXT PRIMARY KEY, app_id TEXT, environment_id TEXT, \
                                      sha TEXT, status TEXT NOT NULL, log TEXT, created_at TEXT); \
             CREATE TABLE main.pull_request (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_comment (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_review (id TEXT PRIMARY KEY NOT NULL); \
             PRAGMA main.user_version = 103;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a 103 database");
        apply(
            &mut conn,
            "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);",
            SCHEMA_VERSION,
            MIGRATIONS,
        )
        .await
        .expect("migrate forward");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);

        for table in ["pull_request", "pr_comment", "pr_review"] {
            let columns: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = 'author_label'",
            )
            .bind(table)
            .fetch_one(&mut conn)
            .await
            .expect("column lookup");
            assert_eq!(columns, 1, "{table} gained author_label");
        }
    }

    /// The 105 step gives a finished deploy its own error line: a database
    /// from the previous baseline gains the column on `deploy`, NULL for every
    /// row it already holds, so the history keeps rendering and only new runs
    /// carry a row-level reason.
    #[tokio::test]
    async fn the_deploy_error_step_upgrades_a_stamped_database() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             CREATE TABLE main.deploy (id TEXT PRIMARY KEY, app_id TEXT, environment_id TEXT, \
                                      sha TEXT, status TEXT NOT NULL, intent TEXT NOT NULL, \
                                      actor TEXT, log TEXT, created_at TEXT, updated_at TEXT); \
             CREATE TABLE main.pull_request (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_comment (id TEXT PRIMARY KEY NOT NULL); \
             CREATE TABLE main.pr_review (id TEXT PRIMARY KEY NOT NULL); \
             INSERT INTO main.deploy (id, app_id, status, intent, log) \
                 VALUES ('d1', 'a1', 'failed', 'deploy', 'ERROR: boom'); \
             PRAGMA main.user_version = 104;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a 104 database");
        apply(
            &mut conn,
            "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);",
            SCHEMA_VERSION,
            MIGRATIONS,
        )
        .await
        .expect("migrate forward");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);

        let found: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('deploy') WHERE name = 'error'",
        )
        .fetch_one(&mut conn)
        .await
        .expect("column lookup");
        assert_eq!(found, 1, "deploy gained error");
        let error: Option<String> =
            sqlx::query_scalar("SELECT error FROM main.deploy WHERE id = 'd1'")
                .fetch_one(&mut conn)
                .await
                .expect("old row");
        assert_eq!(error, None, "an old row has no row-level reason");
    }

    #[tokio::test]
    async fn a_step_above_the_baseline_migrates_forward() {
        let mut conn = memory().await;
        apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect("baseline");
        let next = SCHEMA_VERSION + 1;
        let steps = [Migration {
            version: next,
            sql: "ALTER TABLE main.app ADD COLUMN note TEXT;",
        }];
        apply(&mut conn, BASELINE, next, &steps)
            .await
            .expect("migrate forward");
        assert_eq!(version(&mut conn).await, next);
        let has_column: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app') WHERE name = 'note'")
                .fetch_one(&mut conn)
                .await
                .expect("column");
        assert_eq!(has_column, 1);
    }

    /// Every beta change appends exactly one step: versions run without gaps
    /// from the first step above the baseline to `SCHEMA_VERSION`, so
    /// `plan` can never skip a step and renumbering a shipped step fails
    /// here instead of stranding upgraded installs.
    #[test]
    fn migration_steps_are_append_only_and_contiguous() {
        /// sha256 of one step's SQL, hex-encoded: the manifest below pins
        /// every shipped step's statements.
        fn step_hash(sql: &str) -> String {
            let mut hasher = Sha256::new();
            hasher.update(sql.as_bytes());
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }
        // A shipped step's SQL is frozen: a stamped database skips the step,
        // so editing it reaches fresh installs only. Register the new step's
        // hash when appending; never touch an existing entry.
        const STEP_HASHES: &[(i64, &str)] = &[
            (
                101,
                "2c069c3485da1120d45d4911121ef5d3438fe24b7efacf6e5553e7656f1f10bb",
            ),
            (
                102,
                "994f2b70792a0d1d911067d9a5e666af207e050af79c0c6e949b005eb7ca2ab3",
            ),
            (
                103,
                "9542a7de46e0df9253f62467ecb9bdf80c485fc04dcbb7f3527ea8436806b88a",
            ),
            (
                104,
                "c1622889f209e430226a12687fe8166721dfeff4a0bb1a4be1184b40aae04412",
            ),
            (
                105,
                "fd8ab2aabb7e57b7b3b1383a97600141f28770ad751a05a21b407b1c3d3861e0",
            ),
            (
                106,
                "50064f8124222b6d10a8af2cec6ea4a4145e0776c9fc2eb8ea5fa684bcd89120",
            ),
            (
                107,
                "36f9987c272364f252dde407c42c64da2b515eb76b9aa453444b57dbfd50adea",
            ),
        ];
        let mut expected = FIRST_COMPACTED_VERSION + 1;
        for step in MIGRATIONS {
            assert_eq!(
                step.version, expected,
                "migration steps must be contiguous and ascending: append, never renumber"
            );
            let (_, hash) = STEP_HASHES
                .iter()
                .find(|(version, _)| *version == step.version)
                .expect("every shipped step is registered");
            assert_eq!(&step_hash(step.sql), hash);
            expected += 1;
        }
        assert_eq!(
            SCHEMA_VERSION,
            expected - 1,
            "SCHEMA_VERSION must be the last step: bump it when appending"
        );
    }

    /// `connect` runs `apply` inside one transaction: a step that fails
    /// mid-chain rolls back with the stamp and the shape untouched, so the
    /// next boot retries the same chain instead of resuming past a partial
    /// step.
    #[tokio::test]
    async fn a_failing_step_leaves_the_database_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             PRAGMA main.user_version = 100;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a baseline database");
        let steps = [
            Migration {
                version: FIRST_COMPACTED_VERSION + 1,
                sql: "ALTER TABLE main.app ADD COLUMN note TEXT;",
            },
            Migration {
                version: FIRST_COMPACTED_VERSION + 2,
                sql: "THIS IS NOT SQL;",
            },
        ];
        let mut tx = conn.begin().await.expect("transaction");
        apply(&mut tx, BASELINE, FIRST_COMPACTED_VERSION + 2, &steps)
            .await
            .expect_err("the bad step fails the chain");
        tx.rollback().await.expect("rollback");
        assert_eq!(version(&mut conn).await, 100);
        let partial: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app') WHERE name = 'note'")
                .fetch_one(&mut conn)
                .await
                .expect("column lookup");
        assert_eq!(partial, 0, "the first step's column rolled back too");
    }

    /// The v100 compacted baseline for exactly the tables the post-compaction
    /// steps touch, plus the tables they reference: verbatim `CREATE TABLE`
    /// text from the compaction commit (`8354e97c:apps/runner/schema.sql`),
    /// indexes omitted (current `schema.sql` recreates every kept index on
    /// both sides). A future step that touches another table extends this
    /// fixture with that table's v100-or-later shape; a step whose SQL needs
    /// a column the fixture lacks fails here, not on an install. Tables no
    /// step ever touched are not pinned: a `schema.sql`-only change to one
    /// is invisible to this replay and stays a review-time check.
    const V100_TOUCHED_TABLES: &str = "
        CREATE TABLE IF NOT EXISTS app (
          id TEXT PRIMARY KEY NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT 'local',
          status TEXT NOT NULL DEFAULT 'pending',
          subdomain TEXT NOT NULL,
          git_prefix TEXT NOT NULL,
          fleet_bucket TEXT NOT NULL,
          listen_port INTEGER,
          internal_port INTEGER,
          last_deploy_sha TEXT,
          last_error TEXT,
          desired_state TEXT NOT NULL DEFAULT 'running',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          asleep_since TEXT,
          woke_at TEXT,
          deployed_config TEXT,
          build_uid INTEGER,
          import_source TEXT
        );
        CREATE TABLE IF NOT EXISTS deploy (
          id TEXT PRIMARY KEY NOT NULL,
          app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
          environment_id TEXT REFERENCES environment(id) ON DELETE CASCADE,
          sha TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          log TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS environment (
          id TEXT PRIMARY KEY NOT NULL,
          app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('branch','workspace')),
          git_ref TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          fleet_bucket TEXT NOT NULL,
          listen_port INTEGER,
          internal_port INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          desired_state TEXT NOT NULL DEFAULT 'running',
          asleep_since TEXT,
          woke_at TEXT,
          last_deploy_sha TEXT,
          last_deployed_at TEXT,
          public INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (app_id, label)
        );
        CREATE TABLE IF NOT EXISTS pull_request (
          id TEXT PRIMARY KEY NOT NULL,
          app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          author_id TEXT NOT NULL,
          base TEXT NOT NULL DEFAULT 'main',
          head TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
          head_sha TEXT NOT NULL,
          merge_sha TEXT,
          merged_by TEXT,
          closed_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          merged_at TEXT,
          UNIQUE (app_id, number)
        );
        CREATE TABLE IF NOT EXISTS pr_comment (
          id TEXT PRIMARY KEY NOT NULL,
          pr_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
          author_id TEXT NOT NULL,
          body TEXT NOT NULL,
          path TEXT,
          line INTEGER,
          side TEXT CHECK (side IN ('old','new')),
          commit_sha TEXT,
          created_at TEXT NOT NULL,
          edited_at TEXT
        );
        CREATE TABLE IF NOT EXISTS pr_review (
          id TEXT PRIMARY KEY NOT NULL,
          pr_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
          reviewer_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('approved','changes_requested')),
          commit_sha TEXT NOT NULL,
          created_at TEXT NOT NULL,
          dismissed_at TEXT
        );";

    /// One table's comparable shape: columns with type, default and
    /// nullability, plus every index as (uniqueness, origin, column list).
    /// Auto-indexes (UNIQUE constraints, primary keys) drop their generated
    /// names — only the column sets matter — while `CREATE INDEX` indexes
    /// keep theirs, so a renamed index fails. Explicit indexes also carry
    /// their normalized definition, so a partial-index predicate, sort
    /// direction or collation change fails instead of comparing equal.
    async fn table_shape(conn: &mut SqliteConnection, table: &str) -> Vec<String> {
        let mut shape: Vec<String> = sqlx::query_scalar(
            "SELECT name || ':' || type || ':' || [notnull] || ':' || \
             IFNULL(dflt_value, 'NULL') || ':' || pk FROM pragma_table_info(?)",
        )
        .bind(table)
        .fetch_all(&mut *conn)
        .await
        .expect("columns");
        let indexes: Vec<(String, i64, String)> =
            sqlx::query_as("SELECT name, [unique], origin FROM pragma_index_list(?) ORDER BY name")
                .bind(table)
                .fetch_all(&mut *conn)
                .await
                .expect("indexes");
        for (name, unique, origin) in indexes {
            let columns: Vec<String> =
                sqlx::query_scalar("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
                    .bind(&name)
                    .fetch_all(&mut *conn)
                    .await
                    .expect("index columns");
            let key = if origin == "c" {
                name.clone()
            } else {
                String::new()
            };
            let mut part = format!("index:{unique}:{origin}:{key}:{}", columns.join(","));
            if origin == "c" {
                let sql: String = sqlx::query_scalar(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
                )
                .bind(&name)
                .fetch_one(&mut *conn)
                .await
                .expect("index definition");
                // SQLite stores the statement as written: steps qualify
                // `main.idx_…` while schema.sql does not, and layout differs.
                // Strip the qualifier and collapse whitespace so both sides
                // compare by meaning.
                let normalized = sql
                    .replace("main.", "")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                part.push_str(&format!(":{normalized}"));
            }
            shape.push(part);
        }
        // Column order is intentionally ignored: SQLite appends `ALTER TABLE
        // ... ADD COLUMN` steps after the baseline columns, while a fresh
        // `schema.sql` interleaves them. Every query in `db/` names its
        // columns, so only the sets (with types, defaults and nullability)
        // must agree. Within-index column order is preserved via `seqno`.
        shape.sort();
        shape
    }

    /// The likeliest beta mistake — a step without its `schema.sql` change,
    /// or the reverse — must fail here: a database replayed from the v100
    /// baseline through every step has the same tables, columns, indexes
    /// and triggers as a fresh database built from this build's schema.
    #[tokio::test]
    async fn migrated_baseline_plus_steps_equals_fresh_schema() {
        let schema_sql = include_str!("../schema.sql");
        let mut migrated = memory().await;
        sqlx::raw_sql(V100_TOUCHED_TABLES)
            .execute(&mut migrated)
            .await
            .expect("v100 fixture");
        sqlx::raw_sql("PRAGMA main.user_version = 100;")
            .execute(&mut migrated)
            .await
            .expect("stamp the baseline");
        apply(&mut migrated, schema_sql, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect("migrate forward");
        let mut fresh = memory().await;
        sqlx::raw_sql(schema_sql)
            .execute(&mut fresh)
            .await
            .expect("fresh schema");
        async fn table_names(conn: &mut SqliteConnection) -> Vec<String> {
            sqlx::query_scalar::<_, String>(
                "SELECT name FROM sqlite_master WHERE type = 'table' \
                 AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .fetch_all(conn)
            .await
            .expect("tables")
        }
        async fn trigger_shapes(conn: &mut SqliteConnection) -> Vec<String> {
            sqlx::query_scalar::<_, String>(
                "SELECT name || '|' || tbl_name || '|' || sql FROM sqlite_master \
                 WHERE type = 'trigger' ORDER BY name",
            )
            .fetch_all(conn)
            .await
            .expect("triggers")
        }
        assert_eq!(
            table_names(&mut migrated).await,
            table_names(&mut fresh).await
        );
        for table in table_names(&mut fresh).await {
            assert_eq!(
                table_shape(&mut migrated, &table).await,
                table_shape(&mut fresh, &table).await,
                "table {table} differs between migrated and fresh",
            );
        }
        assert_eq!(
            trigger_shapes(&mut migrated).await,
            trigger_shapes(&mut fresh).await
        );
    }
}
