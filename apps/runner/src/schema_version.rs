//! The runner database's schema stamp and forward-migration runner.
//!
//! `schema.sql` is the complete shape of a fresh database, applied on every
//! boot. There is exactly one lineage: the 0.2.0 beta reset wiped every older
//! shape, so any stamp other than [`SCHEMA_VERSION`] — or an unstamped
//! database that already has tables — is refused, never migrated. A shape
//! change appends a `(version, sql)` to [`MIGRATIONS`] and bumps the constant,
//! and a database stamped below it is migrated forward. A database stamped by
//! a newer build is refused.

use anyhow::{bail, Context};
use sqlx::SqliteConnection;

/// Version a database has after every migration ran. The single post-reset
/// baseline: no pre-reset stamp (alpha 1..16, beta 100..107) may collide
/// with it, so the reset starts at 200, never 1.
pub const SCHEMA_VERSION: i64 = 200;

/// One upgrade step: the statements that take a database from `version - 1`
/// to `version`. Empty at the post-reset baseline; append a step here (and
/// bump [`SCHEMA_VERSION`]) to change the shape of an existing install.
pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// Steps above the baseline, ascending and contiguous. Empty: the reset
/// wiped every older shape, so there is nothing to migrate from.
pub const MIGRATIONS: &[Migration] = &[];

/// The refusal text for a database from before the reset: back the data up,
/// wipe, reinstall. Shared with the control database's refusal.
pub const PRE_RESET_REFUSAL: &str =
    "refusing to start: this database was written by a Noite release \
    before the 0.2.0 beta reset and cannot be upgraded. Back it up if you need it, wipe the data \
    volume and the bucket prefix (or use an empty bucket), then install fresh.";

/// What boot must do to bring a database to the latest version.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Run these migrations (possibly none), then `schema.sql`, then stamp.
    Apply(Vec<i64>),
    /// A database from before the reset: refused, never migrated.
    Legacy { found: i64 },
    /// Stamped newer than this binary: refuse to boot.
    TooNew { found: i64 },
}

/// `stored` is `user_version`; `populated` says the database already has
/// tables. An unstamped database with tables predates versioning entirely.
/// Below the earliest known step there is nothing to migrate from — every
/// such stamp predates the reset — so those databases refuse. With no steps
/// (the post-reset baseline) only the current stamp boots.
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
    if steps.is_empty() {
        // The post-reset baseline migrates nothing: only the current stamp
        // boots, everything else predates the reset.
        return if stored == latest {
            Plan::Apply(Vec::new())
        } else {
            Plan::Legacy { found: stored }
        };
    }
    let first = steps.iter().map(|m| m.version).min().unwrap_or(latest);
    if stored < first - 1 {
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
        Plan::Legacy { .. } => bail!("{PRE_RESET_REFUSAL}"),
        Plan::TooNew { found } => bail!(
            "refusing to start: this database was written by a newer Noite release (schema version \
             {found}; this image only understands up to {latest}) and cannot be upgraded or \
             downgraded across releases. Back it up if you need it, wipe the data volume and the \
             bucket prefix (or use an empty bucket), then install fresh."
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
            version: SCHEMA_VERSION + 1,
            sql: "ALTER TABLE app ADD COLUMN note TEXT;",
        }];
        // Fresh: schema.sql builds it, no steps.
        assert_eq!(plan(0, false, SCHEMA_VERSION, &steps), Plan::Apply(vec![]));
        // This build: nothing to run.
        assert_eq!(
            plan(SCHEMA_VERSION, true, SCHEMA_VERSION, &steps),
            Plan::Apply(vec![])
        );
        // The next step applies on top of this baseline.
        assert_eq!(
            plan(SCHEMA_VERSION, true, SCHEMA_VERSION + 1, &steps),
            Plan::Apply(vec![SCHEMA_VERSION + 1])
        );
        // A beta stamp is refused, never migrated.
        assert_eq!(
            plan(107, true, SCHEMA_VERSION, &steps),
            Plan::Legacy { found: 107 }
        );
        // A pre-compaction alpha stamp is refused, never migrated.
        assert_eq!(
            plan(16, true, SCHEMA_VERSION, &steps),
            Plan::Legacy { found: 16 }
        );
        // An unstamped database with tables predates versioning.
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
    async fn a_beta_stamp_is_refused_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY); PRAGMA main.user_version = 107;")
            .execute(&mut conn)
            .await
            .expect("seed a beta.6 database");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("before the 0.2.0 beta reset"), "{text}");
        assert!(
            text.contains("wipe the data volume and the bucket prefix"),
            "{text}"
        );
        assert_eq!(version(&mut conn).await, 107);
        let columns: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app')")
            .fetch_one(&mut conn)
            .await
            .expect("columns");
        assert_eq!(columns, 1);
    }

    #[tokio::test]
    async fn an_alpha_stamp_is_refused_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY); PRAGMA main.user_version = 16;")
            .execute(&mut conn)
            .await
            .expect("seed an alpha database");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("before the 0.2.0 beta reset"), "{text}");
        assert!(
            text.contains("wipe the data volume and the bucket prefix"),
            "{text}"
        );
        assert_eq!(version(&mut conn).await, 16);
    }

    #[tokio::test]
    async fn an_unstamped_database_with_tables_is_refused_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY);")
            .execute(&mut conn)
            .await
            .expect("seed an unstamped database with tables");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("before the 0.2.0 beta reset"), "{text}");
        assert!(
            text.contains("wipe the data volume and the bucket prefix"),
            "{text}"
        );
        assert_eq!(version(&mut conn).await, 0);
    }

    #[tokio::test]
    async fn a_newer_stamp_is_refused_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY); PRAGMA main.user_version = 201;")
            .execute(&mut conn)
            .await
            .expect("seed a newer database");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("newer Noite release"), "{text}");
        assert!(
            text.contains("wipe the data volume and the bucket prefix"),
            "{text}"
        );
        assert_eq!(version(&mut conn).await, 201);
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

    /// `connect` runs `apply` inside one transaction: a step that fails
    /// mid-chain rolls back with the stamp and the shape untouched, so the
    /// next boot retries the same chain instead of resuming past a partial
    /// step.
    #[tokio::test]
    async fn a_failing_step_leaves_the_database_untouched() {
        let mut conn = memory().await;
        sqlx::raw_sql(
            "CREATE TABLE main.app (id TEXT PRIMARY KEY, slug TEXT); \
             PRAGMA main.user_version = 200;",
        )
        .execute(&mut conn)
        .await
        .expect("seed a baseline database");
        let steps = [
            Migration {
                version: SCHEMA_VERSION + 1,
                sql: "ALTER TABLE main.app ADD COLUMN note TEXT;",
            },
            Migration {
                version: SCHEMA_VERSION + 2,
                sql: "THIS IS NOT SQL;",
            },
        ];
        let mut tx = conn.begin().await.expect("transaction");
        apply(&mut tx, BASELINE, SCHEMA_VERSION + 2, &steps)
            .await
            .expect_err("the bad step fails the chain");
        tx.rollback().await.expect("rollback");
        assert_eq!(version(&mut conn).await, 200);
        let partial: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app') WHERE name = 'note'")
                .fetch_one(&mut conn)
                .await
                .expect("column lookup");
        assert_eq!(partial, 0, "the first step's column rolled back too");
    }
}
