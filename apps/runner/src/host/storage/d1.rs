//! D1 tenant-DB preview + curated writes via `celld d1 execute`.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use serde::Serialize;

use crate::config::Config;
use crate::host::cmd;
use crate::host::source;
use crate::models::App;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct D1Preview {
    pub app_id: String,
    pub app_slug: String,
    pub database_id: String,
    pub tables: Vec<String>,
    pub rows: Vec<String>,
    /// Per-table `PRAGMA table_info` --json (parallel to `tables`; `"[]"`
    /// when the pragma fails) — column names, types and pk positions for
    /// the admin panel's create/edit drawer.
    pub schemas: Vec<String>,
}

/// Materialize the deployed source into a persistent project dir so celld's
/// `d1` can find wrangler.jsonc (resolve_config reads it from the cwd).
async fn ensure_project(cfg: &Config, app: &App) -> anyhow::Result<PathBuf> {
    let Some(rev) = source::resolve_rev(cfg, app).await? else {
        bail!("no deployed source — push to main first");
    };
    let proj = cmd::work_root(cfg).join("projects").join(&app.slug);
    source::checkout_worktree(cfg, &app.slug, &rev, &proj).await?;
    Ok(proj)
}

/// Curated read-only D1 preview: table list + first rows of each.
pub async fn d1_preview(
    cfg: &Config,
    app: &App,
    database_id: &str,
    limit: usize,
) -> anyhow::Result<D1Preview> {
    // celld d1 must resolve the declared database from this app's own
    // wrangler.jsonc (cwd), and needs its S3 bucket to find the fleet node.
    // Use the stored fleet bucket exactly as ensure_fleet passes it to celld.
    let proj = ensure_project(cfg, app).await?;
    let bucket = app.fleet_bucket.clone();
    let env_owned = cmd::aws_env(cfg);
    let mut env: Vec<(&str, &str)> =
        env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));

    // celld d1 knows no sqlite3 dot-commands, so `.tables` fails the SQL
    // parse inside the cell. Enumerate instead with the read-only
    // `PRAGMA table_list` the cell's SQL authorizer explicitly allows, and
    // take --json rows so the parsing reads fields, not whitespace soup.
    let sql = "PRAGMA table_list";
    let tables_out = cmd::run_cmd(
        &cfg.celld_bin,
        &[
            "d1", "execute", database_id,
            "--command", sql,
            "--json",
            "--bucket", &bucket,
        ],
        Some(&proj),
        &env,
        Duration::from_secs(30),
    )
    .await
    .with_context(|| format!("celld d1 {database_id}"))?;

    // Keep real tables only, and exclude SQLite/celld internals (sqlite_*,
    // _cf_* / ltx control, _litestream_*) plus the wrangler migration
    // bookkeeping table.
    let mut tables: Vec<String> = Vec::new();
    for line in tables_out.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if row.get("type").and_then(|v| v.as_str()) != Some("table") {
            continue;
        }
        let Some(name) = row.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if name.starts_with('_') || name.starts_with("sqlite_") || name == "d1_migrations" {
            continue;
        }
        tables.push(name.to_string());
    }

    let mut rows = Vec::new();
    let mut schemas = Vec::new();
    for table in &tables {
        let sql = format!("SELECT * FROM \"{}\" LIMIT {}", table, limit);
        // Push unconditionally (empty on failure) so `rows` stays aligned
        // with `tables` — the client indexes both by table position.
        rows.push(
            cmd::run_cmd(
                &cfg.celld_bin,
                &["d1", "execute", database_id, "--command", &sql, "--bucket", &bucket],
                Some(&proj),
                &env,
                Duration::from_secs(30),
            )
            .await
            .unwrap_or_default(),
        );
        let pragma = format!("PRAGMA table_info({})", quote_ident(table));
        schemas.push(
            d1_exec(cfg, app, database_id, &pragma, true)
                .await
                .unwrap_or_else(|_| "[]".to_string()),
        );
    }

    Ok(D1Preview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        database_id: database_id.to_string(),
        tables,
        rows,
        schemas,
    })
}

/// Run one `celld d1 execute` statement against the app's fleet. Single
/// place where tenant-DB SQL meets the shell: callers pass validated SQL
/// only (see d1_write) — never raw browser input.
async fn d1_exec(
    cfg: &Config,
    app: &App,
    database_id: &str,
    sql: &str,
    json: bool,
) -> anyhow::Result<String> {
    let proj = ensure_project(cfg, app).await?;
    let bucket = app.fleet_bucket.clone();
    let env_owned = cmd::aws_env(cfg);
    let mut env: Vec<(&str, &str)> =
        env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));
    let mut args = vec!["d1", "execute", database_id, "--command", sql];
    if json {
        args.push("--json");
    }
    args.extend(["--bucket", bucket.as_str()]);
    cmd::run_cmd(&cfg.celld_bin, &args, Some(&proj), &env, Duration::from_secs(30))
        .await
        .with_context(|| format!("celld d1 {}", database_id))
}

/// Quote an SQLite identifier — the only SQL splicing in the write path.
/// Callers pass allowlisted table names and schema-validated columns only.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Render a UI value as SQL: JSON null → NULL, numerics for
/// INTEGER/REAL-affinity columns stay bare, everything else is 'escaped'.
fn literal(decltype: &str, value: Option<&str>) -> String {
    let Some(v) = value else {
        return "NULL".to_string();
    };
    let upper = decltype.to_uppercase();
    let numeric = upper.contains("INT")
        || upper.contains("REAL")
        || upper.contains("FLOA")
        || upper.contains("DOUB");
    if numeric && v.parse::<f64>().is_ok() {
        return v.to_string();
    }
    format!("'{}'", v.replace('\'', "''"))
}

/// One PRAGMA table_info row: name + declared type (pk positions travel
/// in the raw pragma JSON the preview ships to the admin panel).
struct D1Column {
    name: String,
    decltype: String,
}

async fn d1_columns(
    cfg: &Config,
    app: &App,
    database_id: &str,
    table: &str,
) -> anyhow::Result<Vec<D1Column>> {
    let out = d1_exec(
        cfg,
        app,
        database_id,
        &format!("PRAGMA table_info({})", quote_ident(table)),
        true,
    )
    .await?;
    let mut cols = Vec::new();
    for line in out.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(name) = row.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        cols.push(D1Column {
            name: name.to_string(),
            decltype: row
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(cols)
}

/// Curated tenant-DB write: a single INSERT or UPDATE built from validated
/// identifiers + escaped literals. The table must exist with a readable
/// schema, every column must come from its PRAGMA, and UPDATE requires a
/// non-empty key (whole-table updates are refused).
pub async fn d1_write(
    cfg: &Config,
    app: &App,
    database_id: &str,
    table: &str,
    op: &str,
    values: &BTreeMap<String, Option<String>>,
    key: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<()> {
    if table.is_empty() || table.starts_with('_') || table.starts_with("sqlite_") {
        bail!("unknown table");
    }
    let cols = d1_columns(cfg, app, database_id, table).await?;
    if cols.is_empty() {
        bail!("unknown table");
    }
    let lit = |name: &str, value: Option<&str>| -> anyhow::Result<String> {
        let Some(col) = cols.iter().find(|c| c.name == name) else {
            bail!("unknown column {}", name);
        };
        Ok(literal(&col.decltype, value))
    };
    // Key conjunctions (validates key columns too); `= NULL` never
    // matches — spell null keys explicitly.
    let conds = |key: &BTreeMap<String, Option<String>>| -> anyhow::Result<Vec<String>> {
        if key.is_empty() {
            bail!("needs a key");
        }
        let mut out = Vec::new();
        for (name, value) in key {
            out.push(match value.as_deref() {
                None => format!("{} IS NULL", quote_ident(name)),
                Some(_) => format!(
                    "{} = {}",
                    quote_ident(name),
                    lit(name, value.as_deref())?
                ),
            });
        }
        Ok(out)
    };
    let sql = match op {
        "insert" => {
            if values.is_empty() {
                bail!("no values");
            }
            let mut names = Vec::new();
            let mut vals = Vec::new();
            for (name, value) in values {
                names.push(quote_ident(name));
                vals.push(lit(name, value.as_deref())?);
            }
            format!(
                "INSERT INTO {} ({}) VALUES ({})",
                quote_ident(table),
                names.join(", "),
                vals.join(", ")
            )
        }
        "update" => {
            if values.is_empty() {
                bail!("no values");
            }
            let mut sets = Vec::new();
            for (name, value) in values {
                sets.push(format!(
                    "{} = {}",
                    quote_ident(name),
                    lit(name, value.as_deref())?
                ));
            }
            format!(
                "UPDATE {} SET {} WHERE {}",
                quote_ident(table),
                sets.join(", "),
                conds(key)?.join(" AND ")
            )
        }
        "delete" => {
            format!(
                "DELETE FROM {} WHERE {}",
                quote_ident(table),
                conds(key)?.join(" AND ")
            )
        }
        _ => bail!("unknown op"),
    };
    d1_exec(cfg, app, database_id, &sql, false).await?;
    Ok(())
}
