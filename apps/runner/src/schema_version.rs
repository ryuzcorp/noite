//! The runner database's schema stamp.
//!
//! `schema.sql` is the complete schema of a fresh database, applied
//! idempotently on every boot. Alpha builds do not upgrade a database between
//! versions: a file written by a different alpha is refused, never migrated.
//! The stamp exists only to tell this build's own restarts apart from a
//! database that predates the compaction. Versioned upgrades return in beta.

use anyhow::{bail, Context};
use sqlx::SqliteConnection;

/// Stamp written by this alpha line. A database carrying any other non-zero
/// stamp was written by a different alpha and is refused.
pub const SCHEMA_VERSION: i64 = 1;

/// Bring a fresh database to the shipped shape, or refuse one from another
/// alpha. The caller owns the transaction.
pub async fn apply(
    conn: &mut SqliteConnection,
    // Always a compile-time schema (`include_str!` in production, literals
    // in tests): sqlx 0.9 only takes `&'static str` or an audited wrapper.
    schema_sql: &'static str,
    latest: i64,
) -> anyhow::Result<()> {
    let stored: i64 = sqlx::query_scalar("PRAGMA main.user_version")
        .fetch_one(&mut *conn)
        .await
        .context("read schema version")?;
    if stored != 0 && stored != latest {
        bail!(
            "refusing to start: the runner database is schema version {stored}, but this alpha \
             build only understands a fresh database (version {latest}). Alpha builds do not \
             upgrade between versions; wipe the data volume and install again."
        );
    }
    if stored == 0 {
        // A truly fresh database has no tables. An unstamped file with the
        // `app` table is a pre-versioning alpha: refuse it rather than
        // applying a schema that cannot reshape it.
        let populated: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'table' AND name = 'app'",
        )
        .fetch_one(&mut *conn)
        .await
        .context("probe database")?;
        if populated > 0 {
            bail!(
                "refusing to start: the runner database predates versioned alpha builds. Alpha \
                 builds do not upgrade between versions; wipe the data volume and install again."
            );
        }
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
    async fn fresh_database_gets_the_shape_and_the_stamp() {
        let mut conn = memory().await;
        apply(&mut conn, BASELINE, SCHEMA_VERSION)
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
        apply(&mut conn, BASELINE, SCHEMA_VERSION)
            .await
            .expect("first boot");
        apply(&mut conn, BASELINE, SCHEMA_VERSION)
            .await
            .expect("second boot");
        assert_eq!(version(&mut conn).await, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn a_database_from_another_alpha_is_refused() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY); PRAGMA main.user_version = 16;")
            .execute(&mut conn)
            .await
            .expect("seed an alpha.27 database");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(text.contains("schema version 16"), "{text}");
        assert!(text.contains("wipe the data volume"), "{text}");
        // Nothing was reshaped or stamped.
        assert_eq!(version(&mut conn).await, 16);
        let columns: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('app')")
            .fetch_one(&mut conn)
            .await
            .expect("columns");
        assert_eq!(columns, 1);
    }

    #[tokio::test]
    async fn an_unstamped_populated_database_is_refused() {
        let mut conn = memory().await;
        sqlx::raw_sql("CREATE TABLE app (id TEXT PRIMARY KEY);")
            .execute(&mut conn)
            .await
            .expect("seed a pre-versioning database");
        let err = apply(&mut conn, BASELINE, SCHEMA_VERSION)
            .await
            .expect_err("refused");
        assert!(
            format!("{err:#}").contains("predates versioned alpha builds"),
            "{err:#}"
        );
        assert_eq!(version(&mut conn).await, 0);
    }
}
