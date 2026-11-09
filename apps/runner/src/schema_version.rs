//! The runner database's schema stamp and forward-migration runner.
//!
//! `schema.sql` is the complete shape of a fresh database, applied on every
//! boot. Alpha databases stamped 1..16 predate the 2026-11-09 compaction and
//! are refused, not migrated: they predate the compaction and cannot be reshaped in place. This build's
//! baseline is [`SCHEMA_VERSION`] with an empty [`MIGRATIONS`]; a future shape
//! change appends a `(version, sql)` above the baseline and bumps the constant,
//! and a database stamped at the baseline is migrated forward. A database
//! stamped by a newer build is refused.

use anyhow::{bail, Context};
use sqlx::SqliteConnection;

/// First stamp of the compacted schema. Stamps below it are pre-compaction
/// alphas and are refused.
pub const FIRST_COMPACTED_VERSION: i64 = 100;

/// Version a database has after every migration ran.
pub const SCHEMA_VERSION: i64 = FIRST_COMPACTED_VERSION;

/// One upgrade step: the statements that take a database from `version - 1`
/// to `version`. Empty at the compacted baseline; append above it to change
/// the shape of an existing install.
pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// Steps above the baseline, ascending and contiguous.
pub const MIGRATIONS: &[Migration] = &[];

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

    #[tokio::test]
    async fn a_step_above_the_baseline_migrates_forward() {
        let mut conn = memory().await;
        apply(&mut conn, BASELINE, SCHEMA_VERSION, MIGRATIONS)
            .await
            .expect("baseline");
        let next = FIRST_COMPACTED_VERSION + 1;
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
}
