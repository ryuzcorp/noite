//! The runner database's version stamp and upgrade path.
//!
//! `schema.sql` is the shape of a FRESH database and stays idempotent. What it
//! cannot do is change a table an install already has, so every such change is
//! a numbered entry in [`MIGRATIONS`], run once, in order, before `schema.sql`
//! on any database that predates it. The version lives in SQLite's
//! `PRAGMA user_version` on the main file, so a migration and its stamp commit
//! atomically.
//!
//! Rules for a shape change that existing installs must survive:
//! 1. Bump [`SCHEMA_VERSION`] and append `(version, sql)` to [`MIGRATIONS`].
//! 2. Edit the matching `CREATE` in `schema.sql` too (a fresh install skips
//!    the migrations).
//! 3. Qualify every table as `main.<name>`: a bare name can resolve into the
//!    ATTACHed `metrics.sqlite`.
//!
//! A database stamped newer than this binary is refused: running old code over
//! a newer shape corrupts it quietly.

use anyhow::{bail, Context};
use sqlx::SqliteConnection;

/// Version a database has after every migration ran. 1 is the alpha baseline.
pub const SCHEMA_VERSION: i64 = 7;

/// One upgrade step: the statements that take a database from `version - 1`
/// to `version`.
pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// Steps above the baseline, ascending and contiguous (`2..=SCHEMA_VERSION`).
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 2,
        // Pending-telemetry-replay requests (`noite-runner telemetry reingest`
        // writes one). The shape only; step 4 asks for the one-time replay.
        sql: "CREATE TABLE IF NOT EXISTS main.telemetry_replay (\
            id INTEGER PRIMARY KEY CHECK (id = 1),\
            floor_us INTEGER NOT NULL,\
            slug TEXT,\
            requested_at TEXT NOT NULL\
          );",
    },
    Migration {
        version: 3,
        // Per-app build uid (SPEC, Tenant isolation): builds and release
        // commands run as one uid per app so two concurrent builds cannot read
        // each other's worktree or cache. The column is nullable here — SQLite
        // rejects a UNIQUE column in ALTER TABLE — and filled on the app's first
        // build by `db::ensure_app_build_uid`. A fresh database gets it from
        // schema.sql. The table is qualified in the ALTER; in `CREATE INDEX …
        // ON app` it cannot be (SQLite rejects a schema-qualified table there),
        // and `app` is a main table, so the bare name is unambiguous.
        sql: "ALTER TABLE main.app ADD COLUMN build_uid INTEGER;\
          CREATE UNIQUE INDEX IF NOT EXISTS idx_app_build_uid ON app(build_uid);",
    },
    Migration {
        version: 4,
        // One-time replay of the retention window, now that the ingest REPLACES a
        // window's aggregates instead of adding to them (so the replay cannot
        // double count). It recovers rows dropped by the pre-alpha.2 ingest bug
        // wherever the bucket still holds them; data older than retention is
        // pruned and gone. `floor_us = 0` means the retention floor; the metrics
        // tick consumes the row and deletes it when every fleet has caught up.
        sql: "INSERT OR IGNORE INTO main.telemetry_replay (id, floor_us, slug, requested_at)\
            VALUES (1, 0, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'));",
    },
    Migration {
        version: 5,
        // Instance-level settings for the opt-out instance heartbeat: the
        // install identity and the last-sent/opt-out markers. A fresh database
        // gets the table from schema.sql; an install that predates alpha.3
        // gains it here.
        sql: "CREATE TABLE IF NOT EXISTS main.instance_setting (\
            key TEXT PRIMARY KEY NOT NULL,\
            value TEXT NOT NULL\
          );",
    },
    Migration {
        version: 6,
        // The `apps.create` source (JSON) an app was imported from (A2/A3):
        // NULL for a blank app, so a failed GitHub/template import can be
        // retried with the same URL, ref and actor. `main.app` is qualified
        // because a bare ALTER can resolve into the ATTACHed `metrics.sqlite`.
        sql: "ALTER TABLE main.app ADD COLUMN import_source TEXT;",
    },
    Migration {
        version: 7,
        // Pull requests (F4): the forge's own data — PRs, their comments and
        // reviews, and the per-app branch protection rule. A fresh database
        // gets the same shape from schema.sql. Indexes cannot be schema-
        // qualified (SQLite rejects `ON main.<table>` in CREATE INDEX) and the
        // names are unique to main, so the bare table name is unambiguous.
        sql: "CREATE TABLE IF NOT EXISTS main.pull_request (\
            id TEXT PRIMARY KEY NOT NULL,\
            app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,\
            number INTEGER NOT NULL,\
            title TEXT NOT NULL,\
            body TEXT NOT NULL DEFAULT '',\
            author_id TEXT NOT NULL,\
            base TEXT NOT NULL DEFAULT 'main',\
            head TEXT NOT NULL,\
            state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),\
            head_sha TEXT NOT NULL,\
            merge_sha TEXT,\
            merged_by TEXT,\
            closed_by TEXT,\
            created_at TEXT NOT NULL,\
            updated_at TEXT NOT NULL,\
            closed_at TEXT,\
            merged_at TEXT,\
            UNIQUE (app_id, number)\
          );\
          CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_request_open \
            ON pull_request(app_id, base, head) WHERE state = 'open';\
          CREATE INDEX IF NOT EXISTS idx_pull_request_app ON pull_request(app_id, number DESC);\
          CREATE TABLE IF NOT EXISTS main.pr_comment (\
            id TEXT PRIMARY KEY NOT NULL,\
            pr_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,\
            author_id TEXT NOT NULL,\
            body TEXT NOT NULL,\
            path TEXT,\
            line INTEGER,\
            side TEXT CHECK (side IN ('old','new')),\
            commit_sha TEXT,\
            created_at TEXT NOT NULL,\
            edited_at TEXT\
          );\
          CREATE INDEX IF NOT EXISTS idx_pr_comment_pr ON pr_comment(pr_id, created_at);\
          CREATE TABLE IF NOT EXISTS main.pr_review (\
            id TEXT PRIMARY KEY NOT NULL,\
            pr_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,\
            reviewer_id TEXT NOT NULL,\
            state TEXT NOT NULL CHECK (state IN ('approved','changes_requested')),\
            commit_sha TEXT NOT NULL,\
            created_at TEXT NOT NULL,\
            dismissed_at TEXT\
          );\
          CREATE INDEX IF NOT EXISTS idx_pr_review_pr ON pr_review(pr_id, created_at);\
          CREATE TABLE IF NOT EXISTS main.app_branch_rule (\
            app_id TEXT PRIMARY KEY NOT NULL REFERENCES app(id) ON DELETE CASCADE,\
            require_pr INTEGER NOT NULL DEFAULT 0,\
            required_approvals INTEGER NOT NULL DEFAULT 0 \
              CHECK (required_approvals BETWEEN 0 AND 2)\
          );",
    },
];

/// What boot must do to bring a database to the latest version.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Run these migrations (possibly none), then `schema.sql`, then stamp.
    Apply(Vec<i64>),
    /// Stamped newer than this binary: refuse to boot.
    TooNew { found: i64 },
}

/// `stored` is `user_version`; `populated` says the database already has
/// tables. A populated database with no stamp predates versioning: it is the
/// baseline (version 1), never a fresh one.
pub fn plan(stored: i64, populated: bool, latest: i64, steps: &[Migration]) -> Plan {
    if stored > latest {
        return Plan::TooNew { found: stored };
    }
    let from = match (stored, populated) {
        (0, true) => 1,
        (0, false) => latest,
        _ => stored,
    };
    Plan::Apply(
        steps
            .iter()
            .map(|m| m.version)
            .filter(|v| *v > from && *v <= latest)
            .collect(),
    )
}

/// Bring the main database to `latest`: migrations first (so `schema.sql`'s
/// indexes find their columns), then the idempotent shape, then the stamp. The
/// caller owns the transaction.
pub async fn apply(
    conn: &mut SqliteConnection,
    schema_sql: &str,
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
    sqlx::raw_sql(&format!("PRAGMA main.user_version = {latest}"))
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
    use sqlx::{Connection, SqliteConnection};

    const BASELINE: &str = "CREATE TABLE IF NOT EXISTS app (id TEXT PRIMARY KEY, slug TEXT);";
    const STEPS: &[Migration] = &[
        Migration {
            version: 2,
            sql: "ALTER TABLE main.app ADD COLUMN note TEXT;",
        },
        Migration {
            version: 3,
            sql: "ALTER TABLE main.app ADD COLUMN tier TEXT;",
        },
    ];

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

    #[test]
    fn shipped_migrations_are_contiguous_above_the_baseline() {
        let versions: Vec<i64> = MIGRATIONS.iter().map(|m| m.version).collect();
        let expected: Vec<i64> = (1..SCHEMA_VERSION).map(|previous| previous + 1).collect();
        assert_eq!(versions, expected);
    }

    #[test]
    fn planning() {
        // Fresh: schema.sql builds it, no steps.
        assert_eq!(plan(0, false, 3, STEPS), Plan::Apply(vec![]));
        // An unstamped install is the baseline: it still needs 2 and 3.
        assert_eq!(plan(0, true, 3, STEPS), Plan::Apply(vec![2, 3]));
        assert_eq!(plan(1, true, 3, STEPS), Plan::Apply(vec![2, 3]));
        assert_eq!(plan(2, true, 3, STEPS), Plan::Apply(vec![3]));
        assert_eq!(plan(3, true, 3, STEPS), Plan::Apply(vec![]));
        assert_eq!(plan(4, true, 3, STEPS), Plan::TooNew { found: 4 });
    }

    #[tokio::test]
    async fn fresh_database_gets_the_shape_and_the_stamp() {
        let mut conn = memory().await;
        apply(&mut conn, BASELINE, 3, STEPS).await.expect("apply");
        assert_eq!(version(&mut conn).await, 3);
        // No migration ran on a fresh database: the column is not there.
        let cols: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app')")
            .fetch_one(&mut conn)
            .await
            .expect("columns");
        assert_eq!(cols, 2);
    }

    #[tokio::test]
    async fn old_install_is_migrated_in_order_and_keeps_its_rows() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY, slug TEXT); INSERT INTO app VALUES ('a', 'blog');")
            .execute(&mut conn)
            .await
            .expect("seed");
        let upgraded = "CREATE TABLE IF NOT EXISTS app (id TEXT PRIMARY KEY, slug TEXT, note TEXT, tier TEXT);\
                        CREATE INDEX IF NOT EXISTS idx_app_tier ON app(tier);";
        apply(&mut conn, upgraded, 3, STEPS).await.expect("upgrade");
        assert_eq!(version(&mut conn).await, 3);
        let slug: String = sqlx::query_scalar("SELECT slug FROM app WHERE id = 'a'")
            .fetch_one(&mut conn)
            .await
            .expect("row survives");
        assert_eq!(slug, "blog");
        // Booting again is a no-op.
        apply(&mut conn, upgraded, 3, STEPS)
            .await
            .expect("second boot");
        assert_eq!(version(&mut conn).await, 3);
    }

    #[tokio::test]
    async fn newer_database_is_refused_with_an_actionable_message() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY); PRAGMA user_version = 9;")
            .execute(&mut conn)
            .await
            .expect("seed");
        let err = apply(&mut conn, BASELINE, 3, STEPS)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("schema version 9"), "{text}");
        assert!(text.contains("Downgrades are not supported"), "{text}");
        assert_eq!(version(&mut conn).await, 9);
    }

    /// The shipped migration that adds `app.build_uid` must apply to a table
    /// that predates it (alpha.2), qualify `main.app` (a bare `ALTER` can
    /// resolve into the attached `metrics.sqlite`), and leave the unique
    /// index enforced.
    #[tokio::test]
    async fn shipped_build_uid_migration_applies_to_an_old_app_table() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT);\
             INSERT INTO main.app VALUES ('a', 'a');\
             PRAGMA main.user_version = 2;",
        )
        .execute(&mut conn)
        .await
        .expect("seed alpha.2 shape");
        let v3 = "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT, build_uid INTEGER);\
                  CREATE UNIQUE INDEX IF NOT EXISTS idx_app_build_uid ON app(build_uid);";
        // Apply just this step: later migrations (other features) must not
        // leak into this test's minimal database.
        let idx = MIGRATIONS
            .iter()
            .position(|m| m.version == 3)
            .expect("the build_uid migration is shipped");
        apply(&mut conn, v3, 3, &MIGRATIONS[idx..=idx])
            .await
            .expect("upgrade");
        assert_eq!(version(&mut conn).await, 3);
        let has_column: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('app') WHERE name = 'build_uid'",
        )
        .fetch_one(&mut conn)
        .await
        .expect("column");
        assert_eq!(has_column, 1, "build_uid added");
        // The row survives unallocated (NULL), and the index still arbitrates.
        let uid: Option<i64> = sqlx::query_scalar("SELECT build_uid FROM main.app WHERE id = 'a'")
            .fetch_one(&mut conn)
            .await
            .expect("row survives");
        assert_eq!(uid, None);
        sqlx::raw_sql("INSERT INTO main.app (id, slug, build_uid) VALUES ('b', 'b', 10030)")
            .execute(&mut conn)
            .await
            .expect("first uid");
        let dup = sqlx::raw_sql("UPDATE main.app SET build_uid = 10030 WHERE id = 'a'")
            .execute(&mut conn)
            .await;
        assert!(dup.is_err(), "the unique index must reject a duplicate uid");
    }

    /// The shipped migration that adds `instance_setting` (the heartbeat's
    /// install identity and opt-out markers) must apply to a database that
    /// predates it, and leave the table usable.
    #[tokio::test]
    async fn shipped_instance_setting_migration_applies_to_an_old_database() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT);\
             PRAGMA main.user_version = 4;",
        )
        .execute(&mut conn)
        .await
        .expect("seed the alpha.3-minus-one shape");
        let v5 = "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);\
                  CREATE TABLE IF NOT EXISTS main.instance_setting (\
                    key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);";
        let idx = MIGRATIONS
            .iter()
            .position(|m| m.version == 5)
            .expect("the instance_setting migration is shipped");
        // Apply just this step: later migrations must not leak into the test.
        apply(&mut conn, v5, 5, &MIGRATIONS[idx..=idx])
            .await
            .expect("upgrade");
        assert_eq!(version(&mut conn).await, 5);
        sqlx::raw_sql("INSERT INTO main.instance_setting (key, value) VALUES ('install_id', 'x')")
            .execute(&mut conn)
            .await
            .expect("insert");
        let value: String =
            sqlx::query_scalar("SELECT value FROM main.instance_setting WHERE key = 'install_id'")
                .fetch_one(&mut conn)
                .await
                .expect("row survives");
        assert_eq!(value, "x");
        // Booting again is a no-op.
        apply(&mut conn, v5, 5, &MIGRATIONS[idx..=idx])
            .await
            .expect("second boot");
        assert_eq!(version(&mut conn).await, 5);
    }

    #[tokio::test]
    async fn shipped_pull_request_migration_applies_to_an_old_database() {
        // A fresh database takes schema.sql and skips this step, so only an
        // upgraded install runs this SQL: it once failed to parse there.
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT);\
             INSERT INTO main.app (id, slug) VALUES ('a1', 'one');\
             PRAGMA main.user_version = 6;",
        )
        .execute(&mut conn)
        .await
        .expect("seed the alpha.4-minus-one shape");
        let v7 = "CREATE TABLE IF NOT EXISTS main.app (id TEXT PRIMARY KEY, slug TEXT);";
        let idx = MIGRATIONS
            .iter()
            .position(|m| m.version == 7)
            .expect("the pull request migration is shipped");
        apply(&mut conn, v7, 7, &MIGRATIONS[idx..=idx])
            .await
            .expect("upgrade");
        assert_eq!(version(&mut conn).await, 7);
        let indexes: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM main.sqlite_master WHERE type = 'index' AND name LIKE 'idx_p%' ORDER BY name",
        )
        .fetch_all(&mut conn)
        .await
        .expect("indexes");
        assert_eq!(
            indexes,
            [
                "idx_pr_comment_pr",
                "idx_pr_review_pr",
                "idx_pull_request_app",
                "idx_pull_request_open"
            ]
        );
        let open = "INSERT INTO main.pull_request \
            (id, app_id, number, title, author_id, head, state, head_sha, created_at, updated_at) \
            VALUES (?, 'a1', ?, 't', 'u', 'feature', 'open', 'abc', 'now', 'now')";
        sqlx::query(open)
            .bind("p1")
            .bind(1)
            .execute(&mut conn)
            .await
            .expect("first open PR");
        assert!(
            sqlx::query(open).bind("p2").bind(2).execute(&mut conn).await.is_err(),
            "a second open PR for the same base/head is refused"
        );
        let rule = "INSERT INTO main.app_branch_rule (app_id, required_approvals) VALUES ('a1', ?)";
        assert!(sqlx::query(rule).bind(3).execute(&mut conn).await.is_err());
        sqlx::query(rule)
            .bind(2)
            .execute(&mut conn)
            .await
            .expect("2 approvals allowed");
    }
}
