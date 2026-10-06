//! D1 table editor: table list, schema introspection, and server-side
//! paging/sort/filter via `celld d1 execute --json`, plus curated writes.
//!
//! Every read is a `celld d1 execute` call that returns JSON rows (the CLI's
//! table output is never parsed). Identifiers only ever come from the
//! `PRAGMA` allowlist; values go through the escaped-literal helper. The
//! editor contract lives in `local://d1-contract.md`.
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::config::Config;
use crate::host::{exec, s3};
use crate::host::source;
use crate::models::App;

/// Filters are AND-ed and bounded so a query can't grow without limit.
pub const MAX_FILTERS: usize = 10;
/// One `delete_rows` call carries at most this many keys.
pub const MAX_DELETE_KEYS: usize = 100;
/// Page size when the caller omits it.
pub const DEFAULT_PAGE_SIZE: i64 = 25;
/// The server clamps every page size into this range (contract).
pub const MIN_PAGE_SIZE: i64 = 1;
pub const MAX_PAGE_SIZE: i64 = 100;

// ---------------------------------------------------------------------------
// Outputs (camelCase JSON, mirrored by `apps/noite/src/lib/runner.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1TableInfo {
    pub name: String,
    pub row_count: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1Tables {
    pub database_id: String,
    pub tables: Vec<D1TableInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1Column {
    pub name: String,
    /// Declared type; "" when the DDL has none.
    #[serde(rename = "type")]
    pub col_type: String,
    pub not_null: bool,
    /// DDL default expression text; null when none.
    pub default_value: Option<String>,
    /// 0 = not part of the PK, else 1-based position.
    pub pk: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1ForeignKey {
    pub from: String,
    pub table: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1Index {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1TableSchemaRaw {
    pub table: String,
    pub columns: Vec<D1Column>,
    pub foreign_keys: Vec<D1ForeignKey>,
    pub indexes: Vec<D1Index>,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct D1Rows {
    pub table: String,
    /// Column order of `rows`.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// COUNT(*) under the same filters/search.
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum D1FilterOp {
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    Like,
    IsNull,
    NotNull,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct D1Filter {
    pub column: String,
    pub op: D1FilterOp,
    /// Ignored for is_null/not_null; `like` takes the user's pattern with `%`
    /// wildcards as typed.
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct D1Sort {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct D1RowsQuery {
    pub table: String,
    /// 0-based.
    #[serde(default)]
    pub page: i64,
    #[serde(default = "default_page_size", alias = "pageSize")]
    pub page_size: i64,
    /// null = primary key order (rowid when the table has no PK).
    #[serde(default)]
    pub sort: Option<D1Sort>,
    #[serde(default)]
    pub filters: Vec<D1Filter>,
    /// "" = none; case-insensitive substring over every non-redacted column.
    #[serde(default)]
    pub search: String,
}

fn default_page_size() -> i64 {
    DEFAULT_PAGE_SIZE
}

/// REST `POST .../tables/{table}/rows` body: the query minus `table`, which
/// travels in the path.
#[derive(Debug, Clone, Deserialize)]
pub struct D1RowsBody {
    #[serde(default)]
    pub page: i64,
    #[serde(default = "default_page_size", alias = "pageSize")]
    pub page_size: i64,
    #[serde(default)]
    pub sort: Option<D1Sort>,
    #[serde(default)]
    pub filters: Vec<D1Filter>,
    #[serde(default)]
    pub search: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum D1WriteOp {
    Insert,
    Update,
    Delete,
}

impl D1WriteOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct D1WriteBody {
    pub op: D1WriteOp,
    pub table: String,
    /// update/delete row identity.
    #[serde(default)]
    #[ts(as = "Option<BTreeMap<String, Option<String>>>", optional)]
    pub key: BTreeMap<String, Option<String>>,
    /// insert/update; null = SQL NULL, "" = empty string.
    #[serde(default)]
    pub values: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct D1DeleteRowsBody {
    pub table: String,
    pub keys: Vec<BTreeMap<String, Option<String>>>,
}

// RPC parameter envelopes (snake_case, per the runner RPC convention).
#[derive(Deserialize)]
pub struct D1TablesParams {
    pub id: String,
    pub database_id: String,
}

#[derive(Deserialize)]
pub struct D1SchemaParams {
    pub id: String,
    pub database_id: String,
    pub table: String,
}

#[derive(Deserialize)]
pub struct D1RowsParams {
    pub id: String,
    pub database_id: String,
    #[serde(flatten)]
    pub query: D1RowsQuery,
}

#[derive(Deserialize)]
pub struct D1WriteParams {
    pub id: String,
    pub database_id: String,
    #[serde(flatten)]
    pub body: D1WriteBody,
}

#[derive(Deserialize)]
pub struct D1DeleteRowsParams {
    pub id: String,
    pub database_id: String,
    pub table: String,
    pub keys: Vec<BTreeMap<String, Option<String>>>,
}

// ---------------------------------------------------------------------------
// SQL building (pure — unit-tested)
// ---------------------------------------------------------------------------

/// One table's schema as the builders see it.
#[derive(Debug, Clone)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<D1Column>,
}

impl TableSchema {
    fn column(&self, name: &str) -> Option<&D1Column> {
        self.columns.iter().find(|c| c.name == name)
    }

    /// PK column names ordered by their 1-based `pk` position.
    fn pk_columns(&self) -> Vec<&str> {
        let mut pk: Vec<(&str, i64)> = self
            .columns
            .iter()
            .filter(|c| c.pk > 0)
            .map(|c| (c.name.as_str(), c.pk))
            .collect();
        pk.sort_by_key(|(_, pos)| *pos);
        pk.into_iter().map(|(name, _)| name).collect()
    }
}

/// True for the real, user-facing tables (internals and the migration
/// bookkeeping table are hidden, matching the control D1 browser).
pub fn visible_table(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('_')
        && !name.starts_with("sqlite_")
        && name != "d1_migrations"
}

/// Quote an SQLite identifier — the only identifier splicing in the D1 path.
/// Callers pass allowlisted table/column names only.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// A single-quoted SQL string literal.
fn string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Escape the LIKE metacharacters (`\`, `%`, `_`) so a search needle matches
/// literally under `ESCAPE '\'`.
fn escape_like(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len());
    for ch in needle.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Render a UI value for a column: JSON null → NULL, "" → the empty string;
/// numbers for INTEGER/REAL-affinity columns stay bare so REAL precision is
/// preserved, everything else is quote-escaped.
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
    if v.is_empty() {
        return "''".to_string();
    }
    string_literal(v)
}

/// A column reference validated against the schema's allowlist.
fn check_column<'a>(schema: &'a TableSchema, name: &str) -> anyhow::Result<&'a D1Column> {
    schema.column(name).with_context(|| "unknown column")
}

/// `WHERE` conditions for the filters and search (AND-ed).
fn where_clause(
    schema: &TableSchema,
    filters: &[D1Filter],
    search: &str,
    redacted: &BTreeSet<String>,
) -> anyhow::Result<Option<String>> {
    if filters.len() > MAX_FILTERS {
        bail!("at most {MAX_FILTERS} filters");
    }
    let mut parts: Vec<String> = Vec::new();
    for filter in filters {
        if redacted.contains(&filter.column) {
            bail!("column cannot be filtered");
        }
        let col = check_column(schema, &filter.column)?;
        let id = quote_ident(&col.name);
        let part = match filter.op {
            D1FilterOp::Eq => format!("{id} = {}", literal(&col.col_type, Some(&filter.value))),
            D1FilterOp::Neq => {
                format!("{id} <> {}", literal(&col.col_type, Some(&filter.value)))
            }
            D1FilterOp::Lt => format!("{id} < {}", literal(&col.col_type, Some(&filter.value))),
            D1FilterOp::Lte => format!("{id} <= {}", literal(&col.col_type, Some(&filter.value))),
            D1FilterOp::Gt => format!("{id} > {}", literal(&col.col_type, Some(&filter.value))),
            D1FilterOp::Gte => format!("{id} >= {}", literal(&col.col_type, Some(&filter.value))),
            // The user's pattern as typed (its own `%`/`_` wildcards stay live).
            D1FilterOp::Like => {
                format!("{id} LIKE {}", string_literal(&filter.value))
            }
            D1FilterOp::IsNull => format!("{id} IS NULL"),
            D1FilterOp::NotNull => format!("{id} IS NOT NULL"),
        };
        parts.push(part);
    }
    if !search.is_empty() {
        let pattern = format!("%{}%", escape_like(search));
        let needle = string_literal(&pattern);
        let mut ors: Vec<String> = Vec::new();
        for col in &schema.columns {
            if redacted.contains(&col.name) {
                continue;
            }
            ors.push(format!(
                "CAST({} AS TEXT) LIKE {needle} ESCAPE '\\'",
                quote_ident(&col.name)
            ));
        }
        if !ors.is_empty() {
            parts.push(format!("({})", ors.join(" OR ")));
        }
    }
    if parts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(parts.join(" AND ")))
    }
}

/// `ORDER BY`: the requested column, else the primary key, else `rowid`.
fn order_clause(schema: &TableSchema, sort: Option<&D1Sort>) -> anyhow::Result<String> {
    if let Some(sort) = sort {
        let col = check_column(schema, &sort.column)?;
        let dir = if sort.desc { "DESC" } else { "ASC" };
        return Ok(format!("ORDER BY {} {dir}", quote_ident(&col.name)));
    }
    let pk = schema.pk_columns();
    if pk.is_empty() {
        // A WITHOUT ROWID table always has a PK, so no PK means rowid is valid.
        Ok("ORDER BY rowid ASC".to_string())
    } else {
        let parts: Vec<String> = pk
            .iter()
            .map(|name| format!("{} ASC", quote_ident(name)))
            .collect();
        Ok(format!("ORDER BY {}", parts.join(", ")))
    }
}

/// The page query: every column, filters/search, order and pagination.
pub fn build_select(
    schema: &TableSchema,
    filters: &[D1Filter],
    search: &str,
    sort: Option<&D1Sort>,
    page: i64,
    page_size: i64,
    redacted: &BTreeSet<String>,
) -> anyhow::Result<String> {
    let columns: Vec<String> = schema
        .columns
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect();
    let mut sql = format!(
        "SELECT {} FROM {}",
        columns.join(", "),
        quote_ident(&schema.name)
    );
    if let Some(where_) = where_clause(schema, filters, search, redacted)? {
        sql.push_str(&format!(" WHERE {where_}"));
    }
    sql.push_str(&format!(" {}", order_clause(schema, sort)?));
    let offset = page.max(0) * page_size;
    sql.push_str(&format!(" LIMIT {page_size} OFFSET {offset}"));
    Ok(sql)
}

/// COUNT(*) under the same filters/search as the page query.
pub fn build_count(
    schema: &TableSchema,
    filters: &[D1Filter],
    search: &str,
    redacted: &BTreeSet<String>,
) -> anyhow::Result<String> {
    let mut sql = format!("SELECT COUNT(*) AS n FROM {}", quote_ident(&schema.name));
    if let Some(where_) = where_clause(schema, filters, search, redacted)? {
        sql.push_str(&format!(" WHERE {where_}"));
    }
    Ok(sql)
}

/// Validate a write/delete key: every column exists, and the key names exactly
/// the PK (or every column when the table has no PK).
fn check_key(schema: &TableSchema, key: &BTreeMap<String, Option<String>>) -> anyhow::Result<()> {
    if key.is_empty() {
        bail!("needs a key");
    }
    for name in key.keys() {
        check_column(schema, name)?;
    }
    let given: BTreeSet<&str> = key.keys().map(String::as_str).collect();
    let pk = schema.pk_columns();
    if pk.is_empty() {
        let all: BTreeSet<&str> = schema.columns.iter().map(|c| c.name.as_str()).collect();
        if given != all {
            bail!("table has no primary key: the key must name every column");
        }
    } else {
        let expected: BTreeSet<&str> = pk.into_iter().collect();
        if given != expected {
            bail!("key must match the primary key");
        }
    }
    Ok(())
}

/// `col = value` / `col IS NULL` conjunctions for a key.
fn key_conditions(
    schema: &TableSchema,
    key: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<String> {
    check_key(schema, key)?;
    let mut out: Vec<String> = Vec::new();
    for (name, value) in key {
        let col = check_column(schema, name)?;
        out.push(match value {
            None => format!("{} IS NULL", quote_ident(name)),
            Some(v) => format!(
                "{} = {}",
                quote_ident(name),
                literal(&col.col_type, Some(v))
            ),
        });
    }
    Ok(out.join(" AND "))
}

pub fn build_insert(
    schema: &TableSchema,
    values: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<String> {
    if values.is_empty() {
        bail!("no values");
    }
    let mut names: Vec<String> = Vec::new();
    let mut vals: Vec<String> = Vec::new();
    for (name, value) in values {
        let col = check_column(schema, name)?;
        names.push(quote_ident(name));
        vals.push(literal(&col.col_type, value.as_deref()));
    }
    Ok(format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_ident(&schema.name),
        names.join(", "),
        vals.join(", ")
    ))
}

pub fn build_update(
    schema: &TableSchema,
    values: &BTreeMap<String, Option<String>>,
    key: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<String> {
    if values.is_empty() {
        bail!("no values");
    }
    let mut sets: Vec<String> = Vec::new();
    for (name, value) in values {
        let col = check_column(schema, name)?;
        sets.push(format!(
            "{} = {}",
            quote_ident(name),
            literal(&col.col_type, value.as_deref())
        ));
    }
    Ok(format!(
        "UPDATE {} SET {} WHERE {}",
        quote_ident(&schema.name),
        sets.join(", "),
        key_conditions(schema, key)?
    ))
}

pub fn build_delete(
    schema: &TableSchema,
    key: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<String> {
    Ok(format!(
        "DELETE FROM {} WHERE {}",
        quote_ident(&schema.name),
        key_conditions(schema, key)?
    ))
}

/// One atomic batch of DELETEs, each followed by `changes()` so the caller can
/// total the rows actually removed. `celld d1 execute` brackets several
/// statements in one transaction, so a failure rolls the whole batch back.
pub fn build_delete_keys(
    schema: &TableSchema,
    keys: &[BTreeMap<String, Option<String>>],
) -> anyhow::Result<String> {
    if keys.is_empty() {
        bail!("no keys");
    }
    if keys.len() > MAX_DELETE_KEYS {
        bail!("at most {MAX_DELETE_KEYS} rows per delete");
    }
    let mut sql = String::new();
    for key in keys {
        sql.push_str(&format!(
            "DELETE FROM {} WHERE {}; SELECT changes() AS n; ",
            quote_ident(&schema.name),
            key_conditions(schema, key)?
        ));
    }
    Ok(sql
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .to_string())
}

/// One exec for every table's row count:
/// `SELECT 'name' AS t, COUNT(*) AS n FROM "name" UNION ALL …`.
pub fn build_table_counts(tables: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for name in tables {
        parts.push(format!(
            "SELECT {} AS t, COUNT(*) AS n FROM {}",
            string_literal(name),
            quote_ident(name)
        ));
    }
    parts.join(" UNION ALL ")
}

// ---------------------------------------------------------------------------
// celld plumbing
// ---------------------------------------------------------------------------

/// `celld d1 execute` against one app's fleet. Holds the materialized project
/// so a multi-exec operation pays the checkout once.
struct D1<'a> {
    cfg: &'a Config,
    app: &'a App,
    database_id: String,
    proj: PathBuf,
}

impl<'a> D1<'a> {
    async fn connect(cfg: &'a Config, app: &'a App, database_id: &str) -> anyhow::Result<D1<'a>> {
        let proj = ensure_project(cfg, app).await?;
        Ok(D1 {
            cfg,
            app,
            database_id: database_id.to_string(),
            proj,
        })
    }

    /// One `celld d1 execute` statement (or several) against the app's fleet.
    /// Single place where tenant-DB SQL meets the shell: callers pass
    /// validated SQL only — never raw browser input.
    async fn exec(&self, sql: &str, json: bool) -> anyhow::Result<String> {
        let bucket = self.app.fleet_bucket.clone();
        let env_owned = s3::aws_env(self.cfg);
        let mut env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
        env.push(("S3_ENDPOINT", self.cfg.s3_endpoint.as_str()));
        let mut args = vec!["d1", "execute", self.database_id.as_str(), "--command", sql];
        if json {
            args.push("--json");
        }
        args.extend(["--bucket", bucket.as_str()]);
        exec::run_cmd(
            &self.cfg.celld_bin,
            &args,
            Some(&self.proj),
            &env,
            Duration::from_secs(30),
        )
        .await
        .with_context(|| format!("celld d1 {}", self.database_id))
    }
}

/// Materialize the deployed source into a persistent project dir so celld's
/// `d1` can find wrangler.jsonc (resolve_config reads it from the cwd).
async fn ensure_project(cfg: &Config, app: &App) -> anyhow::Result<PathBuf> {
    let Some(rev) = source::resolve_rev(cfg, app).await? else {
        bail!("no deployed source — push to main first");
    };
    let proj = exec::work_root(cfg).join("projects").join(&app.slug);
    source::checkout_worktree(cfg, &app.slug, &rev, &proj).await?;
    // Configs generated at deploy time (cloudflare.config.ts, a built
    // dist/wrangler.json) are not in the source tree; write what the last
    // deploy uploaded so celld can resolve the database bindings.
    let has_config = ["wrangler.jsonc", "wrangler.json"]
        .iter()
        .any(|name| proj.join(name).exists());
    if !has_config {
        if let Some(json) = app.deployed_config.as_deref() {
            tokio::fs::write(proj.join("wrangler.json"), json).await?;
        }
    }
    Ok(proj)
}

/// Parse `--json` output: one JSON object per line (informational lines are
/// skipped; the CLI writes them to stderr, but be tolerant).
fn parse_json_rows(out: &str) -> Vec<serde_json::Map<String, Value>> {
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// One cell as the UI sees it: NULL → null, numbers stringified exactly,
/// blobs as `x'hex'`.
fn cell_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
        Value::Array(items) => {
            let bytes: Vec<u8> = items
                .iter()
                .filter_map(|item| item.as_u64().map(|n| n as u8))
                .collect();
            Some(format!("x'{}'", hex(&bytes)))
        }
        other => Some(other.to_string()),
    }
}

fn json_i64(row: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| v.as_i64())
}

fn json_str<'a>(row: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(|v| v.as_str())
}

/// Real, user-facing table names, alphabetically.
async fn table_names(d1: &D1<'_>) -> anyhow::Result<Vec<String>> {
    let out = d1.exec("PRAGMA table_list", true).await?;
    let mut names: Vec<String> = Vec::new();
    for row in parse_json_rows(&out) {
        if json_str(&row, "type") != Some("table") {
            continue;
        }
        let Some(name) = json_str(&row, "name") else {
            continue;
        };
        if !visible_table(name) {
            continue;
        }
        names.push(name.to_string());
    }
    names.sort();
    Ok(names)
}

/// Columns from `PRAGMA table_info` (empty = unknown table).
async fn load_columns(d1: &D1<'_>, table: &str) -> anyhow::Result<Vec<D1Column>> {
    let out = d1
        .exec(&format!("PRAGMA table_info({})", quote_ident(table)), true)
        .await?;
    let mut columns = Vec::new();
    for row in parse_json_rows(&out) {
        let Some(name) = json_str(&row, "name") else {
            continue;
        };
        columns.push(D1Column {
            name: name.to_string(),
            col_type: json_str(&row, "type").unwrap_or("").to_string(),
            not_null: json_i64(&row, "notnull").unwrap_or(0) != 0,
            default_value: row.get("dflt_value").and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            }),
            pk: json_i64(&row, "pk").unwrap_or(0),
        });
    }
    Ok(columns)
}

/// `table_info` only — enough to validate and build a read/write.
async fn load_table(d1: &D1<'_>, table: &str) -> anyhow::Result<TableSchema> {
    let columns = load_columns(d1, table).await?;
    if columns.is_empty() {
        bail!("unknown table {table}");
    }
    Ok(TableSchema {
        name: table.to_string(),
        columns,
    })
}

/// Full schema for the Definition view: columns, foreign keys, indexes, DDL.
async fn load_schema(d1: &D1<'_>, table: &str) -> anyhow::Result<D1TableSchemaRaw> {
    let schema = load_table(d1, table).await?;

    let fk_out = d1
        .exec(
            &format!("PRAGMA foreign_key_list({})", quote_ident(table)),
            true,
        )
        .await?;
    let mut foreign_keys = Vec::new();
    for row in parse_json_rows(&fk_out) {
        let (Some(from), Some(ftable), Some(to)) = (
            json_str(&row, "from"),
            json_str(&row, "table"),
            json_str(&row, "to"),
        ) else {
            continue;
        };
        foreign_keys.push(D1ForeignKey {
            from: from.to_string(),
            table: ftable.to_string(),
            to: to.to_string(),
        });
    }

    let idx_out = d1
        .exec(&format!("PRAGMA index_list({})", quote_ident(table)), true)
        .await?;
    let mut indexes = Vec::new();
    for row in parse_json_rows(&idx_out) {
        let Some(name) = json_str(&row, "name") else {
            continue;
        };
        let info_out = d1
            .exec(&format!("PRAGMA index_info({})", quote_ident(name)), true)
            .await?;
        let mut cols: Vec<(i64, String)> = Vec::new();
        for info in parse_json_rows(&info_out) {
            let Some(col) = json_str(&info, "name") else {
                continue;
            };
            cols.push((json_i64(&info, "seqno").unwrap_or(0), col.to_string()));
        }
        cols.sort_by_key(|(seqno, _)| *seqno);
        indexes.push(D1Index {
            name: name.to_string(),
            unique: json_i64(&row, "unique").unwrap_or(0) != 0,
            columns: cols.into_iter().map(|(_, col)| col).collect(),
        });
    }

    let sql_out = d1
        .exec(
            &format!(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = {}",
                string_literal(table)
            ),
            true,
        )
        .await?;
    let sql = parse_json_rows(&sql_out)
        .into_iter()
        .find_map(|row| json_str(&row, "sql").map(str::to_string));

    Ok(D1TableSchemaRaw {
        table: table.to_string(),
        columns: schema.columns,
        foreign_keys,
        indexes,
        sql,
    })
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/// Tables plus row counts, in one `SELECT … UNION ALL …` exec.
pub async fn d1_tables(cfg: &Config, app: &App, database_id: &str) -> anyhow::Result<D1Tables> {
    let d1 = D1::connect(cfg, app, database_id).await?;
    let names = table_names(&d1).await?;
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    if !names.is_empty() {
        let out = d1.exec(&build_table_counts(&names), true).await?;
        for row in parse_json_rows(&out) {
            if let (Some(name), Some(n)) = (json_str(&row, "t"), json_i64(&row, "n")) {
                counts.insert(name.to_string(), n);
            }
        }
    }
    let tables = names
        .into_iter()
        .map(|name| D1TableInfo {
            row_count: counts.get(&name).copied().unwrap_or(0),
            name,
        })
        .collect();
    Ok(D1Tables {
        database_id: database_id.to_string(),
        tables,
    })
}

/// One table's schema (the caller adds caps/locked/redacted/rowAction).
pub async fn d1_schema(
    cfg: &Config,
    app: &App,
    database_id: &str,
    table: &str,
) -> anyhow::Result<D1TableSchemaRaw> {
    if !visible_table(table) {
        bail!("unknown table");
    }
    let d1 = D1::connect(cfg, app, database_id).await?;
    load_schema(&d1, table).await
}

/// One server-side page of rows plus the total under the same filters/search.
pub async fn d1_rows(
    cfg: &Config,
    app: &App,
    database_id: &str,
    query: &D1RowsQuery,
) -> anyhow::Result<D1Rows> {
    if !visible_table(&query.table) {
        bail!("unknown table");
    }
    let d1 = D1::connect(cfg, app, database_id).await?;
    let schema = load_table(&d1, &query.table).await?;
    let redacted: BTreeSet<String> = BTreeSet::new();
    let page_size = query.page_size.clamp(MIN_PAGE_SIZE, MAX_PAGE_SIZE);
    let page = query.page.max(0);
    let select = build_select(
        &schema,
        &query.filters,
        &query.search,
        query.sort.as_ref(),
        page,
        page_size,
        &redacted,
    )?;
    let count = build_count(&schema, &query.filters, &query.search, &redacted)?;
    let rows_out = d1.exec(&select, true).await?;
    let count_out = d1.exec(&count, true).await?;

    let columns: Vec<String> = schema.columns.iter().map(|c| c.name.clone()).collect();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    for row in parse_json_rows(&rows_out) {
        rows.push(
            columns
                .iter()
                .map(|col| cell_value(row.get(col).unwrap_or(&Value::Null)))
                .collect(),
        );
    }
    let total = parse_json_rows(&count_out)
        .into_iter()
        .find_map(|row| json_i64(&row, "n"))
        .unwrap_or(0);
    Ok(D1Rows {
        table: query.table.clone(),
        columns,
        rows,
        total,
        page,
        page_size,
    })
}

/// Curated single-statement write (insert/update/delete).
pub async fn d1_write(
    cfg: &Config,
    app: &App,
    database_id: &str,
    op: &str,
    table: &str,
    values: &BTreeMap<String, Option<String>>,
    key: &BTreeMap<String, Option<String>>,
) -> anyhow::Result<()> {
    if !visible_table(table) {
        bail!("unknown table");
    }
    let d1 = D1::connect(cfg, app, database_id).await?;
    let schema = load_table(&d1, table).await?;
    let sql = match op {
        "insert" => build_insert(&schema, values)?,
        "update" => build_update(&schema, values, key)?,
        "delete" => build_delete(&schema, key)?,
        other => bail!("unknown op {other}"),
    };
    d1.exec(&sql, false).await?;
    Ok(())
}

/// Delete 1..100 rows by key. One exec = one transaction: all-or-nothing.
pub async fn d1_delete_rows(
    cfg: &Config,
    app: &App,
    database_id: &str,
    table: &str,
    keys: &[BTreeMap<String, Option<String>>],
) -> anyhow::Result<u64> {
    if !visible_table(table) {
        bail!("unknown table");
    }
    let d1 = D1::connect(cfg, app, database_id).await?;
    let schema = load_table(&d1, table).await?;
    let sql = build_delete_keys(&schema, keys)?;
    let out = d1.exec(&sql, true).await?;
    let deleted: i64 = parse_json_rows(&out)
        .iter()
        .filter_map(|row| json_i64(row, "n"))
        .sum();
    Ok(deleted.max(0) as u64)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, decltype: &str, pk: i64) -> D1Column {
        D1Column {
            name: name.to_string(),
            col_type: decltype.to_string(),
            not_null: false,
            default_value: None,
            pk,
        }
    }

    fn table(columns: Vec<D1Column>) -> TableSchema {
        TableSchema {
            name: "t".to_string(),
            columns,
        }
    }

    fn users() -> TableSchema {
        table(vec![
            col("id", "INTEGER", 1),
            col("name", "TEXT", 0),
            col("age", "REAL", 0),
            col("note", "TEXT", 0),
        ])
    }

    fn no_redactions() -> BTreeSet<String> {
        BTreeSet::new()
    }

    fn filter(column: &str, op: D1FilterOp, value: &str) -> D1Filter {
        D1Filter {
            column: column.to_string(),
            op,
            value: value.to_string(),
        }
    }

    #[test]
    fn filter_ops_render() {
        let t = users();
        let cases = [
            (D1FilterOp::Eq, "\"id\" = 7"),
            (D1FilterOp::Neq, "\"name\" <> 'bob'"),
            (D1FilterOp::Lt, "\"id\" < 7"),
            (D1FilterOp::Lte, "\"id\" <= 7"),
            (D1FilterOp::Gt, "\"id\" > 7"),
            (D1FilterOp::Gte, "\"id\" >= 7"),
            (D1FilterOp::Like, "\"name\" LIKE '%o%'"),
            (D1FilterOp::IsNull, "\"note\" IS NULL"),
            (D1FilterOp::NotNull, "\"note\" IS NOT NULL"),
        ];
        for (op, expected) in cases {
            let column = if matches!(op, D1FilterOp::IsNull | D1FilterOp::NotNull) {
                "note"
            } else if matches!(op, D1FilterOp::Like | D1FilterOp::Neq) {
                "name"
            } else {
                "id"
            };
            let value = if matches!(op, D1FilterOp::Like) {
                "%o%".to_string()
            } else if column == "name" {
                "bob".to_string()
            } else {
                "7".to_string()
            };
            let f = filter(column, op, &value);
            let sql = build_count(&t, &[f], "", &no_redactions()).unwrap();
            assert!(sql.ends_with(&format!("WHERE {expected}")), "{sql}");
        }
    }

    #[test]
    fn like_searches_escape_metacharacters() {
        let t = users();
        let f = filter("name", D1FilterOp::Like, "50%_\\x");
        let sql = build_select(&t, &[f], "", None, 0, 25, &no_redactions()).unwrap();
        // The user's LIKE pattern is taken as typed (its wildcards live).
        assert!(sql.contains("WHERE \"name\" LIKE '50%_\\x'"), "{sql}");
    }

    #[test]
    fn search_escapes_needle_and_quotes() {
        let t = users();
        let sql = build_select(&t, &[], "50%_\\'x", None, 0, 25, &no_redactions()).unwrap();
        // `%`, `_`, `\` become escaped; the quote doubles inside the literal.
        assert!(
            sql.contains("LIKE '%50\\%\\_\\\\''x%' ESCAPE '\\'"),
            "{sql}"
        );
        // Every column participates in the OR.
        for column in ["id", "name", "age", "note"] {
            assert!(
                sql.contains(&format!("CAST(\"{column}\" AS TEXT) LIKE")),
                "{sql}"
            );
        }
    }

    #[test]
    fn search_skips_redacted_columns() {
        let t = users();
        let redacted: BTreeSet<String> = ["name".to_string()].into_iter().collect();
        let sql = build_select(&t, &[], "ada", None, 0, 25, &redacted).unwrap();
        assert!(!sql.contains("CAST(\"name\" AS TEXT)"), "{sql}");
        assert!(sql.contains("CAST(\"id\" AS TEXT)"), "{sql}");
    }

    #[test]
    fn unknown_column_and_table_refused() {
        let t = users();
        let f = filter("nope", D1FilterOp::Eq, "1");
        assert!(build_count(&t, &[f], "", &no_redactions()).is_err());
        let sort = D1Sort {
            column: "nope".to_string(),
            desc: false,
        };
        assert!(build_select(&t, &[], "", Some(&sort), 0, 25, &no_redactions()).is_err());
        // A filter on a redacted column is refused (would leak by bisection).
        let redacted: BTreeSet<String> = ["name".to_string()].into_iter().collect();
        let f = filter("name", D1FilterOp::Eq, "x");
        assert!(build_count(&t, &[f], "", &redacted).is_err());
    }

    #[test]
    fn default_order_is_primary_key() {
        let t = table(vec![
            col("b", "TEXT", 2),
            col("a", "TEXT", 1),
            col("v", "TEXT", 0),
        ]);
        let sql = build_select(&t, &[], "", None, 0, 25, &no_redactions()).unwrap();
        assert!(sql.contains("ORDER BY \"a\" ASC, \"b\" ASC"), "{sql}");
    }

    #[test]
    fn default_order_is_rowid_without_pk() {
        let t = table(vec![col("a", "TEXT", 0), col("b", "TEXT", 0)]);
        let sql = build_select(&t, &[], "", None, 0, 25, &no_redactions()).unwrap();
        assert!(sql.contains("ORDER BY rowid ASC"), "{sql}");
    }

    #[test]
    fn explicit_sort_and_pagination() {
        let t = users();
        let sort = D1Sort {
            column: "age".to_string(),
            desc: true,
        };
        let sql = build_select(&t, &[], "", Some(&sort), 3, 50, &no_redactions()).unwrap();
        assert!(sql.contains("ORDER BY \"age\" DESC"), "{sql}");
        assert!(sql.ends_with("LIMIT 50 OFFSET 150"), "{sql}");
        // Pages before zero clamp.
        let sql = build_select(&t, &[], "", None, -4, 25, &no_redactions()).unwrap();
        assert!(sql.ends_with("LIMIT 25 OFFSET 0"), "{sql}");
    }

    #[test]
    fn too_many_filters_refused() {
        let t = users();
        let filters: Vec<D1Filter> = (0..=MAX_FILTERS)
            .map(|_| filter("id", D1FilterOp::Eq, "1"))
            .collect();
        assert!(build_count(&t, &filters, "", &no_redactions()).is_err());
    }

    #[test]
    fn null_and_empty_string_are_distinct() {
        let t = users();
        let mut values: BTreeMap<String, Option<String>> = BTreeMap::new();
        values.insert("name".to_string(), None);
        values.insert("note".to_string(), Some(String::new()));
        let sql = build_insert(&t, &values).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"t\" (\"name\", \"note\") VALUES (NULL, '')"
        );
    }

    #[test]
    fn insert_omits_absent_columns() {
        let t = users();
        let mut values: BTreeMap<String, Option<String>> = BTreeMap::new();
        values.insert("name".to_string(), Some("ada".to_string()));
        let sql = build_insert(&t, &values).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"t\" (\"name\") VALUES ('ada')".to_string()
        );
    }

    #[test]
    fn numeric_columns_stay_bare() {
        let t = users();
        let mut values: BTreeMap<String, Option<String>> = BTreeMap::new();
        values.insert("id".to_string(), Some("42".to_string()));
        values.insert("age".to_string(), Some("1e+300".to_string()));
        let sql = build_update(&t, &values, &pk_key("42")).unwrap();
        assert!(sql.contains("SET \"age\" = 1e+300, \"id\" = 42"), "{sql}");
    }

    #[test]
    fn update_refuses_empty_values() {
        let t = users();
        let empty: BTreeMap<String, Option<String>> = BTreeMap::new();
        assert!(build_update(&t, &empty, &pk_key("1")).is_err());
    }

    fn pk_key(id: &str) -> BTreeMap<String, Option<String>> {
        let mut key: BTreeMap<String, Option<String>> = BTreeMap::new();
        key.insert("id".to_string(), Some(id.to_string()));
        key
    }

    #[test]
    fn key_must_match_primary_key() {
        let t = users();
        // Wrong column.
        let mut key: BTreeMap<String, Option<String>> = BTreeMap::new();
        key.insert("name".to_string(), Some("ada".to_string()));
        assert!(build_delete(&t, &key).is_err());
        // Missing PK column on a composite PK.
        let composite = table(vec![
            col("a", "TEXT", 1),
            col("b", "TEXT", 2),
            col("v", "TEXT", 0),
        ]);
        let mut key: BTreeMap<String, Option<String>> = BTreeMap::new();
        key.insert("a".to_string(), Some("x".to_string()));
        assert!(build_delete(&composite, &key).is_err());
        // Exact match is accepted.
        let mut key: BTreeMap<String, Option<String>> = BTreeMap::new();
        key.insert("a".to_string(), Some("x".to_string()));
        key.insert("b".to_string(), Some("y".to_string()));
        assert!(build_delete(&composite, &key).is_ok());
    }

    #[test]
    fn no_pk_key_must_name_every_column() {
        let t = table(vec![col("a", "TEXT", 0), col("b", "TEXT", 0)]);
        let mut key: BTreeMap<String, Option<String>> = BTreeMap::new();
        key.insert("a".to_string(), Some("x".to_string()));
        assert!(build_delete(&t, &key).is_err());
        key.insert("b".to_string(), Some("y".to_string()));
        assert!(build_delete(&t, &key).is_ok());
    }

    #[test]
    fn null_key_uses_is_null() {
        let t = users();
        let mut key: BTreeMap<String, Option<String>> = BTreeMap::new();
        key.insert("id".to_string(), None);
        let sql = build_delete(&t, &key).unwrap();
        assert_eq!(sql, "DELETE FROM \"t\" WHERE \"id\" IS NULL");
    }

    #[test]
    fn delete_keys_batch_is_atomic_and_counted() {
        let t = users();
        let keys = vec![pk_key("1"), pk_key("2")];
        let sql = build_delete_keys(&t, &keys).unwrap();
        assert_eq!(
            sql,
            "DELETE FROM \"t\" WHERE \"id\" = 1; SELECT changes() AS n; \
             DELETE FROM \"t\" WHERE \"id\" = 2; SELECT changes() AS n"
        );
    }

    #[test]
    fn delete_keys_bounds() {
        let t = users();
        assert!(build_delete_keys(&t, &[]).is_err());
        let too_many: Vec<BTreeMap<String, Option<String>>> = (0..=MAX_DELETE_KEYS)
            .map(|i| pk_key(&i.to_string()))
            .collect();
        assert!(build_delete_keys(&t, &too_many).is_err());
    }

    #[test]
    fn table_counts_union_all() {
        let sql = build_table_counts(&["a".to_string(), "b'b".to_string()]);
        assert_eq!(
            sql,
            "SELECT 'a' AS t, COUNT(*) AS n FROM \"a\" UNION ALL \
             SELECT 'b''b' AS t, COUNT(*) AS n FROM \"b'b\""
        );
    }

    #[test]
    fn quote_ident_doubles_quotes() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn cell_values_render_exactly() {
        assert_eq!(cell_value(&Value::Null), None);
        assert_eq!(cell_value(&Value::String("x".into())), Some("x".into()));
        assert_eq!(
            cell_value(&serde_json::json!(200000)),
            Some("200000".into())
        );
        assert_eq!(cell_value(&serde_json::json!(1e300)), Some("1e+300".into()));
        assert_eq!(
            cell_value(&serde_json::json!([1, 2, 255])),
            Some("x'0102ff'".into())
        );
    }

    #[test]
    fn visibility_hides_internal_tables() {
        assert!(visible_table("users"));
        assert!(!visible_table("_cf_KV"));
        assert!(!visible_table("sqlite_master"));
        assert!(!visible_table("d1_migrations"));
        assert!(!visible_table(""));
    }

    #[test]
    fn outputs_are_camel_case() {
        let tables = D1Tables {
            database_id: "db".to_string(),
            tables: vec![D1TableInfo {
                name: "t".to_string(),
                row_count: 3,
            }],
        };
        assert_eq!(
            serde_json::to_string(&tables).unwrap(),
            r#"{"databaseId":"db","tables":[{"name":"t","rowCount":3}]}"#
        );
        let column = col("id", "INTEGER", 1);
        assert_eq!(
            serde_json::to_string(&column).unwrap(),
            r#"{"name":"id","type":"INTEGER","notNull":false,"defaultValue":null,"pk":1}"#
        );
        let rows = D1Rows {
            table: "t".to_string(),
            columns: vec!["id".to_string()],
            rows: vec![vec![None], vec![Some("1".to_string())]],
            total: 2,
            page: 0,
            page_size: 25,
        };
        assert_eq!(
            serde_json::to_string(&rows).unwrap(),
            r#"{"table":"t","columns":["id"],"rows":[[null],["1"]],"total":2,"page":0,"pageSize":25}"#
        );
    }

    #[test]
    fn filter_ops_deserialize_from_contract_names() {
        let op = |json: &str| -> D1FilterOp { serde_json::from_str::<D1Filter>(json).unwrap().op };
        assert_eq!(
            op(r#"{"column":"a","op":"is_null","value":""}"#),
            D1FilterOp::IsNull
        );
        assert_eq!(
            op(r#"{"column":"a","op":"not_null","value":""}"#),
            D1FilterOp::NotNull
        );
        assert_eq!(
            op(r#"{"column":"a","op":"gte","value":"1"}"#),
            D1FilterOp::Gte
        );
        // An unknown op is refused at the boundary.
        assert!(
            serde_json::from_str::<D1Filter>(r#"{"column":"a","op":"nope","value":""}"#).is_err()
        );
    }
}
