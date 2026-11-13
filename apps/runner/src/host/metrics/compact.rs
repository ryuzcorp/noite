//! Durable compaction (spec T3.5) of completed hours, and the watermark that
//! keeps it from running twice.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parquet::basic::{Compression, ConvertedType, Repetition, Type as PhysicalType, ZstdLevel};
use parquet::data_type::{BoolType, ByteArray, ByteArrayType, Int32Type, Int64Type};
use parquet::file::properties::WriterProperties;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::writer::{SerializedFileWriter, SerializedRowGroupWriter};
use parquet::record::Field;
use parquet::schema::types::Type;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::s3;

use super::parquet_io::{self, Fetched};
use super::plan::telemetry_prefix;
use super::MetricsState;

/// Split one hour directory's keys into `(already_compacted, foldable
/// sources)`. A compacted file plus extra sources means a flush landed after
/// (or during) the last compaction: the extras are late arrivals, not
/// leftovers, and must be folded in — never deleted unread.
fn compaction_plan(keys: &[String], target: &str) -> (bool, Vec<String>) {
    let has_target = keys.iter().any(|k| k == target);
    let sources = keys
        .iter()
        .filter(|k| k.as_str() != target)
        .cloned()
        .collect();
    (has_target, sources)
}

/// What one pass over an hour directory must do: `None` when there is nothing
/// to fold, otherwise the exact input list for the re-COPY. The existing
/// target always leads the inputs when it exists, so a flush that landed
/// between COPY and delete — or after a completed compaction — is folded
/// into the compacted file instead of being destroyed unread.
fn compaction_inputs(keys: &[String], target: &str) -> Option<Vec<String>> {
    let (has_target, sources) = compaction_plan(keys, target);
    if has_target {
        if sources.is_empty() {
            return None;
        }
        let mut inputs = Vec::with_capacity(sources.len() + 1);
        inputs.push(target.to_string());
        inputs.extend(sources);
        Some(inputs)
    } else if sources.len() < 2 {
        None
    } else {
        Some(sources)
    }
}

/// `yyyy/mm/dd/hh` for a timestamp, as celld partitions telemetry.
pub(super) fn hour_dir(us: i64) -> String {
    chrono::DateTime::from_timestamp_micros(us.max(0))
        .map(|t| t.format("%Y/%m/%d/%H").to_string())
        .unwrap_or_default()
}

/// Rewrite the last completed hour of one fleet's telemetry into one zstd file
/// per node directory, exactly as the docs prescribe ("Run a compaction job on
/// a maintenance node... Run the job once an hour, for the hour that just
/// ended. Do not compact the current hour... Delete the source files after
/// the copy lands"). celld never compacts its own files and we flush every
/// `otel_flush_ms` (120 objects per hour per signal per node at the 30 s
/// default), so without this job a fleet's bucket grows to thousands of tiny
/// files per hour and every ingest listing and decode walks them all.
///
/// Sources are deleted only after `head-object` proves the compacted file
/// exists, so a failed copy can never lose spans. The root comes from
/// [`telemetry_prefix`], so the control fleet's `control/telemetry/...` is
/// compacted exactly like a tenant fleet's.
pub(super) async fn compact_fleet(cfg: &Config, slug: &str, hour: &str) -> anyhow::Result<usize> {
    let mut compacted = 0_usize;
    let prefix = telemetry_prefix(slug);
    for kind in ["traces", "logs"] {
        let root = format!("{prefix}/telemetry/{kind}/");
        let listing = s3::s3_list_delimited(cfg, &cfg.s3_bucket, &root).await?;
        let v: serde_json::Value = serde_json::from_str(listing.trim()).unwrap_or_default();
        let nodes: Vec<String> = v
            .pointer("/CommonPrefixes")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| o.pointer("/Prefix").and_then(|x| x.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for node in nodes {
            let dir = format!("{node}{hour}/");
            let listing = s3::s3_list_delimited(cfg, &cfg.s3_bucket, &dir).await?;
            let v: serde_json::Value = serde_json::from_str(listing.trim()).unwrap_or_default();
            let keys: Vec<String> = v
                .pointer("/Contents")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.pointer("/Key").and_then(|x| x.as_str()))
                        .filter(|k| k.ends_with(".parquet"))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let target = format!("{dir}compacted.parquet");
            // Nothing to fold: a lone compacted file is stable, and one
            // source is already one file.
            let Some(inputs) = compaction_inputs(&keys, &target) else {
                continue;
            };
            copy_union(cfg, &dir, &target, &inputs).await?;
            s3::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
            compacted += 1;
        }
    }
    Ok(compacted)
}

/// Rows buffered before one row group is written. A batch this size is a few
/// hundred kilobytes of telemetry: folding an hour never holds the whole hour
/// in memory, and the compacted file still has few row groups for the ingest
/// to read.
const FOLD_BATCH_ROWS: usize = 8192;

/// Fold the union of `inputs` into `target`, proved with a HEAD before the
/// caller deletes anything. The old implementation was a DuckDB
/// `COPY (SELECT * FROM read_parquet([…], union_by_name=true) …)`; this is the
/// same operation on the Parquet writer, because the runner may not call
/// DuckDB anymore.
///
/// Every input column is preserved (union by name), so an hour that spans a
/// celld upgrade keeps both shapes. Row order inside the file is not
/// significant: every read filters on the event timestamp, never on position.
///
/// When `target` is itself one of the inputs (a re-fold of late arrivals), the
/// fold goes to a staging key first: writing the file it reads would corrupt
/// the hour. The staging key never ends in `.parquet`, so neither the ingest
/// listing nor another compact pass sees it mid-write; the final
/// `rm_dir_except` (keep `compacted.parquet`) removes it with the folded
/// sources.
async fn copy_union(
    cfg: &Config,
    dir: &str,
    target: &str,
    inputs: &[String],
) -> anyhow::Result<()> {
    let refold = inputs.iter().any(|k| k == target);
    let dest = if refold {
        format!("{dir}compacted.staging-{}", uuid::Uuid::new_v4())
    } else {
        target.to_string()
    };
    let work = crate::host::exec::work_root(cfg).join("telemetry-compact");
    tokio::fs::create_dir_all(&work).await?;
    let id = uuid::Uuid::new_v4();
    let sources = spool_inputs(cfg, inputs, &work, id).await?;
    let out = work.join(format!("{id}-fold.parquet"));
    let folded = {
        let sources = sources.clone();
        let out = out.clone();
        tokio::task::spawn_blocking(move || fold_files(&sources, &out))
            .await
            .map_err(|e| anyhow::anyhow!("compaction fold task: {e}"))?
    };
    for path in &sources {
        let _ = tokio::fs::remove_file(path).await;
    }
    folded?;
    let uploaded = s3::s3_cp_upload(cfg, &out, &dest).await;
    let _ = tokio::fs::remove_file(&out).await;
    uploaded?;
    if !s3::s3_object_exists(cfg, &cfg.s3_bucket, &dest).await {
        anyhow::bail!("compacted object missing after copy: {dest}");
    }
    if refold {
        // Publish complete-over-complete: the staging object is whole (HEAD
        // proved), so promoting it keeps a compacted file in the hour at
        // every instant — a crash leaves the old target plus staging, which
        // the next pass re-folds instead of deleting.
        s3::s3_copy_key(cfg, &cfg.s3_bucket, &dest, target).await?;
        if !s3::s3_object_exists(cfg, &cfg.s3_bucket, target).await {
            anyhow::bail!("compacted object missing after promote: {target}");
        }
    }
    Ok(())
}

/// Download every input to a local file so each object is fetched once and the
/// output schema is known before the first row is written. A partial spool is
/// cleaned up on error; a missing object fails the fold (the hour is retried,
/// never marked compacted with data skipped).
async fn spool_inputs(
    cfg: &Config,
    inputs: &[String],
    work: &Path,
    id: uuid::Uuid,
) -> anyhow::Result<Vec<PathBuf>> {
    let mut paths = Vec::with_capacity(inputs.len());
    for (index, key) in inputs.iter().enumerate() {
        let path = work.join(format!("{id}-{index}.parquet"));
        let body = match parquet_io::fetch(cfg, key).await? {
            Fetched::Body(body) => body,
            Fetched::Missing => {
                for done in &paths {
                    let _ = tokio::fs::remove_file(done).await;
                }
                anyhow::bail!("compaction input vanished: {key}");
            }
            Fetched::TooLarge(size) => {
                for done in &paths {
                    let _ = tokio::fs::remove_file(done).await;
                }
                anyhow::bail!(
                    "compaction input {key} is {size} bytes, over the {}-byte cap",
                    parquet_io::MAX_OBJECT_BYTES
                );
            }
        };
        if let Err(e) = tokio::fs::write(&path, &body).await {
            for done in paths.iter().chain(std::iter::once(&path)) {
                let _ = tokio::fs::remove_file(done).await;
            }
            return Err(e).map_err(|e| anyhow::anyhow!("spool {key}: {e}"));
        }
        paths.push(path);
    }
    Ok(paths)
}

/// One output column: its name and the physical kind every input agrees on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ColumnKind {
    Bool,
    Int32,
    Int64,
    Str,
}

struct OutField {
    name: String,
    kind: ColumnKind,
}

/// One cell of a folded row.
#[derive(Debug)]
enum Cell {
    Null,
    Bool(bool),
    Int(i32),
    Long(i64),
    Str(String),
}

/// The union of every input's columns, in first-seen order. Types widen
/// (`INT32` + `INT64` → `INT64`); any other disagreement fails the fold
/// instead of guessing.
fn merge_schema(fields: &mut Vec<OutField>, root: &Type) -> anyhow::Result<()> {
    for field in root.get_fields() {
        if field.is_group() {
            anyhow::bail!(
                "telemetry column {} is nested; only flat columns are supported",
                field.name()
            );
        }
        let kind = match field.get_physical_type() {
            PhysicalType::BOOLEAN => ColumnKind::Bool,
            PhysicalType::INT32 => ColumnKind::Int32,
            PhysicalType::INT64 => ColumnKind::Int64,
            PhysicalType::BYTE_ARRAY => ColumnKind::Str,
            other => anyhow::bail!(
                "telemetry column {} has unsupported physical type {other:?}",
                field.name()
            ),
        };
        match fields
            .iter_mut()
            .find(|existing| existing.name == field.name())
        {
            Some(existing) => {
                existing.kind = match (existing.kind, kind) {
                    (a, b) if a == b => a,
                    (ColumnKind::Int32, ColumnKind::Int64)
                    | (ColumnKind::Int64, ColumnKind::Int32) => ColumnKind::Int64,
                    _ => anyhow::bail!(
                        "telemetry column {} has conflicting types across an hour",
                        field.name()
                    ),
                };
            }
            None => fields.push(OutField {
                name: field.name().to_string(),
                kind,
            }),
        }
    }
    Ok(())
}

/// The output schema: every column optional, so a file that predates one keeps
/// folding and a reader can always project it by name.
fn output_schema(fields: &[OutField]) -> anyhow::Result<Type> {
    let mut children = Vec::with_capacity(fields.len());
    for field in fields {
        let builder = match field.kind {
            ColumnKind::Bool => Type::primitive_type_builder(&field.name, PhysicalType::BOOLEAN),
            ColumnKind::Int32 => Type::primitive_type_builder(&field.name, PhysicalType::INT32),
            ColumnKind::Int64 => Type::primitive_type_builder(&field.name, PhysicalType::INT64),
            ColumnKind::Str => Type::primitive_type_builder(&field.name, PhysicalType::BYTE_ARRAY)
                .with_converted_type(ConvertedType::UTF8),
        };
        children.push(Arc::new(
            builder.with_repetition(Repetition::OPTIONAL).build()?,
        ));
    }
    Ok(Type::group_type_builder("celld_telemetry")
        .with_fields(children)
        .build()?)
}

/// Read every spooled file and write the union to `out`, one row group per
/// [`FOLD_BATCH_ROWS`] rows.
fn fold_files(sources: &[PathBuf], out: &Path) -> anyhow::Result<()> {
    let mut fields: Vec<OutField> = Vec::new();
    let mut readers = Vec::with_capacity(sources.len());
    for path in sources {
        let reader = SerializedFileReader::new(
            File::open(path).map_err(|e| anyhow::anyhow!("open {}: {e}", path.display()))?,
        )
        .map_err(|e| anyhow::anyhow!("parquet open {}: {e}", path.display()))?;
        merge_schema(
            &mut fields,
            reader
                .metadata()
                .file_metadata()
                .schema_descr()
                .root_schema(),
        )?;
        readers.push(reader);
    }
    if fields.is_empty() {
        anyhow::bail!("compaction inputs have no columns");
    }
    let properties = Arc::new(
        WriterProperties::builder()
            .set_compression(Compression::ZSTD(ZstdLevel::default()))
            .build(),
    );
    let mut writer = SerializedFileWriter::new(
        BufWriter::new(
            File::create(out).map_err(|e| anyhow::anyhow!("create {}: {e}", out.display()))?,
        ),
        Arc::new(output_schema(&fields)?),
        properties,
    )?;
    let mut columns: Vec<Vec<Cell>> = fields
        .iter()
        .map(|_| Vec::with_capacity(FOLD_BATCH_ROWS))
        .collect();
    let mut buffered = 0_usize;
    for reader in &readers {
        for row in reader.get_row_iter(None)? {
            let row = row?;
            let cells: Vec<(&str, &Field)> = row
                .get_column_iter()
                .map(|(name, field)| (name.as_str(), field))
                .collect();
            for (index, field) in fields.iter().enumerate() {
                let cell = match cells.iter().find(|(name, _)| *name == field.name.as_str()) {
                    Some((_, value)) => cell_from(value)?,
                    None => Cell::Null,
                };
                columns[index].push(cell);
            }
            buffered += 1;
            if buffered >= FOLD_BATCH_ROWS {
                write_row_group(&mut writer, &fields, &mut columns)?;
                buffered = 0;
            }
        }
    }
    if buffered > 0 {
        write_row_group(&mut writer, &fields, &mut columns)?;
    }
    writer.close()?;
    Ok(())
}

fn cell_from(field: &Field) -> anyhow::Result<Cell> {
    Ok(match field {
        Field::Null => Cell::Null,
        Field::Bool(value) => Cell::Bool(*value),
        Field::Int(value) => Cell::Int(*value),
        Field::Short(value) => Cell::Int(i32::from(*value)),
        Field::Byte(value) => Cell::Int(i32::from(*value)),
        Field::Long(value) => Cell::Long(*value),
        Field::Str(value) => Cell::Str(value.clone()),
        Field::Bytes(value) => Cell::Str(
            std::str::from_utf8(value.data())
                .map_err(|e| anyhow::anyhow!("telemetry text column is not UTF-8: {e}"))?
                .to_string(),
        ),
        other => anyhow::bail!("unsupported telemetry cell type: {other:?}"),
    })
}

fn write_row_group<W: Write + Send>(
    writer: &mut SerializedFileWriter<W>,
    fields: &[OutField],
    columns: &mut [Vec<Cell>],
) -> anyhow::Result<()> {
    let mut group = writer.next_row_group()?;
    for (field, cells) in fields.iter().zip(columns.iter()) {
        write_column(&mut group, field, cells)?;
    }
    group.close()?;
    for cells in columns.iter_mut() {
        cells.clear();
    }
    Ok(())
}

fn write_column<W: Write + Send>(
    group: &mut SerializedRowGroupWriter<'_, W>,
    field: &OutField,
    cells: &[Cell],
) -> anyhow::Result<()> {
    let mut column = group
        .next_column()?
        .ok_or_else(|| anyhow::anyhow!("parquet writer ran out of columns"))?;
    match field.kind {
        ColumnKind::Bool => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Bool(value) => {
                        levels.push(1);
                        values.push(*value);
                    }
                    other => anyhow::bail!("column {}: expected bool, got {other:?}", field.name),
                }
            }
            column
                .typed::<BoolType>()
                .write_batch(&values, Some(&levels), None)?;
        }
        ColumnKind::Int32 => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Int(value) => {
                        levels.push(1);
                        values.push(*value);
                    }
                    other => anyhow::bail!("column {}: expected int32, got {other:?}", field.name),
                }
            }
            column
                .typed::<Int32Type>()
                .write_batch(&values, Some(&levels), None)?;
        }
        ColumnKind::Int64 => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Long(value) => {
                        levels.push(1);
                        values.push(*value);
                    }
                    Cell::Int(value) => {
                        levels.push(1);
                        values.push(i64::from(*value));
                    }
                    other => anyhow::bail!("column {}: expected int64, got {other:?}", field.name),
                }
            }
            column
                .typed::<Int64Type>()
                .write_batch(&values, Some(&levels), None)?;
        }
        ColumnKind::Str => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Str(value) => {
                        levels.push(1);
                        values.push(ByteArray::from(value.as_bytes().to_vec()));
                    }
                    other => anyhow::bail!("column {}: expected text, got {other:?}", field.name),
                }
            }
            column
                .typed::<ByteArrayType>()
                .write_batch(&values, Some(&levels), None)?;
        }
    }
    column.close()?;
    Ok(())
}

/// One completed hour's durable compaction state. The unit of progress is the
/// hour, not a per-fleet high-water mark: a failed hour can never be skipped,
/// because only *that hour* is marked when its fold succeeds.
///
/// stateDiagram-v2
///   [*] --> Pending
///   Pending --> Compacted: fold ok
///   Pending --> Failed: fold error
///   Failed --> Pending: retry window elapsed
///   Failed --> Compacted: fold ok on retry
#[derive(Debug, Clone, Default)]
pub(super) struct CompactionState {
    hours: HashMap<String, HourState>,
    /// The newest hour of the contiguous compacted run. Compaction schedules
    /// from `done + 1` and stops at the first hour that is not ready, so a
    /// failure can never be jumped over.
    done: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HourState {
    Compacted,
    /// The fold failed; retried once this instant has passed. An hour in this
    /// state is never treated as done.
    Failed {
        retry_at: std::time::Instant,
    },
}

/// How long a failed hour waits before the next attempt. Same shape as the
/// ingest backoff: long enough that a broken bucket does not burn every pass,
/// short enough that a transient S3 error heals within minutes.
const COMPACTION_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(120);

impl CompactionState {
    /// Restore the durable per-hour marks loaded at boot.
    pub(super) fn restored(hours: impl IntoIterator<Item = String>) -> Self {
        let hours: HashMap<String, HourState> = hours
            .into_iter()
            .map(|hour| (hour, HourState::Compacted))
            .collect();
        let done = hours.keys().max().cloned();
        Self { hours, done }
    }

    fn next_after(done: &str) -> Option<String> {
        chrono::NaiveDateTime::parse_from_str(&format!("{done}:00:00"), "%Y/%m/%d/%H:%M:%S")
            .ok()
            .and_then(|at| at.checked_add_signed(chrono::Duration::hours(1)))
            .map(|at| at.format("%Y/%m/%d/%H").to_string())
    }

    fn is_due(&self, hour: &str, now: std::time::Instant) -> bool {
        match self.hours.get(hour) {
            None => true,
            Some(HourState::Compacted) => false,
            Some(HourState::Failed { retry_at }) => retry_at <= &now,
        }
    }

    /// Transition `Pending -> Compacted`. The cursor advances only when the
    /// folded hour is exactly the next one, so a write can never skip an
    /// earlier hour.
    fn folded(&mut self, hour: &str) {
        let earlier = self.hours.keys().any(|h| h.as_str() < hour);
        self.hours.insert(hour.to_string(), HourState::Compacted);
        let advances = match &self.done {
            Some(done) => Self::next_after(done).as_deref() == Some(hour),
            // A first fold only opens the cursor when nothing earlier is
            // still tracked (a failed earlier hour must stay ahead of it).
            None => !earlier,
        };
        if advances {
            self.done = Some(hour.to_string());
        }
    }

    /// Transition `Pending -> Failed`. A failed hour is retried after
    /// [`COMPACTION_RETRY_BACKOFF`]; it never becomes `Compacted`.
    fn failed(&mut self, hour: &str, now: std::time::Instant) {
        self.hours.insert(
            hour.to_string(),
            HourState::Failed {
                retry_at: now + COMPACTION_RETRY_BACKOFF,
            },
        );
    }

    /// Drop marks older than the retention window (they can never be due).
    fn prune_before(&mut self, hour: &str) {
        self.hours.retain(|h, _| h.as_str() >= hour);
        if self.done.as_deref().is_some_and(|done| done < hour) {
            self.done = Some(hour.to_string());
        }
    }
}

/// Completed hours that still need a fold, oldest first. Scheduling starts
/// after the contiguous `done` cursor (or the last 25 hours on a fresh fleet)
/// and stops at the first non-ready hour: a failed hour blocks the hours
/// behind it until its retry, so the cursor can never skip it. Bounded so one
/// pass cannot name the whole retention; unparseable input compacts nothing.
pub(super) fn uncompacted_hours(
    state: &CompactionState,
    current: &str,
    cfg: &Config,
) -> Vec<String> {
    let parse = |h: &str| {
        chrono::NaiveDateTime::parse_from_str(&format!("{h}:00:00"), "%Y/%m/%d/%H:%M:%S").ok()
    };
    let Some(current_dt) = parse(current) else {
        return Vec::new();
    };
    let floor =
        chrono::Utc::now().naive_utc() - chrono::Duration::days(cfg.telemetry_retention_days);
    let mut start = match state.done.as_deref().and_then(parse) {
        Some(done) => done + chrono::Duration::hours(1),
        // No mark: only the recent past, not the whole retention.
        None => current_dt - chrono::Duration::hours(25),
    };
    if start < floor {
        start = floor;
    }
    let now = std::time::Instant::now();
    let mut hours = Vec::new();
    while start < current_dt && hours.len() < 48 {
        let hour = start.format("%Y/%m/%d/%H").to_string();
        if state.hours.get(&hour) == Some(&HourState::Compacted) {
            // Already folded (only possible below a restored cursor).
        } else if state.is_due(&hour, now) {
            hours.push(hour);
        } else {
            // A failed hour is backing off: later hours wait their turn.
            break;
        }
        let Some(next) = start.checked_add_signed(chrono::Duration::hours(1)) else {
            break;
        };
        start = next;
    }
    hours
}

/// Transition `Pending -> Failed` for one hour: it is retried after the
/// backoff and, crucially, is not marked compacted.
pub(super) fn mark_failed(state: &mut MetricsState, slug: &str, hour: &str) {
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .failed(hour, std::time::Instant::now());
}

/// Drop in-memory marks that fell out of the retention window.
pub(super) fn prune_marks(state: &mut MetricsState, oldest_hour: &str) {
    for fleet in state.compacted.values_mut() {
        fleet.prune_before(oldest_hour);
    }
}

pub(super) async fn mark_compacted(
    pool: &SqlitePool,
    state: &mut MetricsState,
    slug: &str,
    hour: &str,
) {
    if let Err(e) = db::mark_hour_compacted(pool, slug, hour).await {
        tracing::warn!(error = %e, "compaction mark");
        return;
    }
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .folded(hour);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncompacted_hours_never_names_the_running_hour() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        // Hours relative to now: the retention floor (`Utc::now() - retention`)
        // moves with the wall clock, so fixed dates rot — the hardcoded
        // 2026/09/29 started failing exactly 30 days later (2026-10-29).
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let done = hour(now - chrono::Duration::hours(2));
        let mut state = CompactionState::default();
        state.folded(&done);
        // Compacted two hours back → only the previous hour is pending; a
        // marked hour is never named again.
        assert_eq!(
            uncompacted_hours(&state, &current, &cfg),
            vec![hour(now - chrono::Duration::hours(1))]
        );
        state.folded(&hour(now - chrono::Duration::hours(1)));
        assert!(uncompacted_hours(&state, &current, &cfg).is_empty());
        // Garbage input compacts nothing.
        assert!(uncompacted_hours(&state, "not-an-hour", &cfg).is_empty());
    }

    /// P1: a failed hour must never be skipped because a later hour folded.
    /// The old per-fleet watermark advanced past the failure, so `h` was
    /// never revisited. Per-hour state keeps `h` due and only marks `h + 1`.
    #[test]
    fn a_failed_hour_stays_due_when_a_later_hour_folds() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let failed = hour(now - chrono::Duration::hours(2));
        let later = hour(now - chrono::Duration::hours(1));
        let mut state = CompactionState::default();
        state.failed(&failed, std::time::Instant::now());
        state.folded(&later);
        // The failed hour is retried once its backoff elapses; the folded
        // hour is never named.
        let pending = uncompacted_hours(&state, &current, &cfg);
        assert!(!pending.contains(&later), "{pending:?}");
        // Backoff elapses (injected by rebuilding the failure with a past
        // retry instant through the same transition).
        state.hours.insert(
            failed.clone(),
            HourState::Failed {
                retry_at: std::time::Instant::now(),
            },
        );
        assert!(uncompacted_hours(&state, &current, &cfg).contains(&failed));
    }

    /// Folding an hour only marks that hour: an older failed hour is still
    /// pending, and a gap below the newest mark is revisited.
    #[test]
    fn folding_never_advances_a_watermark_past_a_gap() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let gap = hour(now - chrono::Duration::hours(3));
        let older = hour(now - chrono::Duration::hours(4));
        let mut state = CompactionState::default();
        state.folded(&older);
        state.folded(&hour(now - chrono::Duration::hours(2)));
        state.folded(&hour(now - chrono::Duration::hours(1)));
        let pending = uncompacted_hours(&state, &current, &cfg);
        assert!(
            pending.contains(&gap),
            "the hole below the newest mark is due"
        );
        assert!(
            !pending.contains(&hour(now - chrono::Duration::hours(1))),
            "a compacted hour is never scheduled again"
        );
    }

    #[test]
    fn compaction_plan_prefers_the_compacted_file() {
        let dir = "fleets/blog/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        let src = |n: &str| format!("{dir}{n}.parquet");
        // Nothing compacted yet: every file is a source.
        let (has, sources) = compaction_plan(&[src("a"), src("b")], &target);
        assert!(!has);
        assert_eq!(sources.len(), 2);
        // A finished compaction leaves exactly the compacted file.
        let (has, sources) = compaction_plan(std::slice::from_ref(&target), &target);
        assert!(has);
        assert!(sources.is_empty());
        // A flush that landed after (or during) the last compaction leaves
        // both: the extras are late arrivals, folded back in — never deleted
        // unread.
        let (has, sources) = compaction_plan(&[target.clone(), src("a")], &target);
        assert!(has);
        assert_eq!(sources, vec![src("a")]);
    }

    /// Late sources are re-folded, never dropped: a pass over
    /// `[compacted, late]` must COPY both into the target. The old code
    /// deleted `late` here, so spans flushed mid-pass were destroyed unread —
    /// this test fails on that behavior (no inputs to copy).
    #[test]
    fn late_sources_are_refolded_not_deleted() {
        let dir = "fleets/blog/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        let src = |n: &str| format!("{dir}{n}.parquet");
        // A flush landing between COPY and delete, or after a completed
        // compaction: the target leads the COPY inputs, the late source
        // follows — every byte stays in the hour.
        let inputs = compaction_inputs(&[target.clone(), src("late")], &target)
            .expect("late source must be folded");
        assert_eq!(inputs, vec![target.clone(), src("late")]);
        // Stable hour: nothing to do.
        assert!(compaction_inputs(std::slice::from_ref(&target), &target).is_none());
        // One source is already one file: nothing to do.
        assert!(compaction_inputs(std::slice::from_ref(&src("only")), &target).is_none());
        // Fresh hour: every source is folded.
        let inputs = compaction_inputs(&[src("a"), src("b")], &target).expect("fresh fold");
        assert_eq!(inputs, vec![src("a"), src("b")]);
    }

    /// Write one test input with the same writer primitives the fold uses:
    /// a schema of `fields` and `rows` cells. Returns after `close`.
    fn write_input(path: &Path, fields: &[OutField], rows: Vec<Vec<Cell>>) {
        let properties = Arc::new(WriterProperties::builder().build());
        let mut writer = SerializedFileWriter::new(
            BufWriter::new(File::create(path).expect("test input")),
            Arc::new(output_schema(fields).expect("schema")),
            properties,
        )
        .expect("writer");
        let mut columns: Vec<Vec<Cell>> = fields.iter().map(|_| Vec::new()).collect();
        for row in rows {
            for (column, cell) in columns.iter_mut().zip(row) {
                column.push(cell);
            }
        }
        write_row_group(&mut writer, fields, &mut columns).expect("row group");
        writer.close().expect("close");
    }

    fn read_cells(path: &Path) -> Vec<Vec<String>> {
        let reader = SerializedFileReader::new(File::open(path).expect("open")).expect("read");
        reader
            .get_row_iter(None)
            .expect("rows")
            .map(|row| {
                row.expect("row")
                    .get_column_iter()
                    .map(|(name, field)| match field {
                        Field::Null => format!("{name}=null"),
                        Field::Str(value) => format!("{name}={value}"),
                        Field::Long(value) => format!("{name}={value}"),
                        Field::Int(value) => format!("{name}={value}"),
                        Field::Bool(value) => format!("{name}={value}"),
                        other => format!("{name}={other:?}"),
                    })
                    .collect()
            })
            .collect()
    }

    /// The fold is a union by name: a column only one input carries is kept
    /// (null in the rows that lack it), a wider integer widens, and the row
    /// order of every input survives. This is the `union_by_name=true` the
    /// old DuckDB `COPY` relied on.
    #[test]
    fn fold_keeps_every_input_column_and_row() {
        let guard = crate::testutil::TempDir::new("noite-compact-fold");
        let old = guard.path().join("old.parquet");
        let new = guard.path().join("new.parquet");
        let out = guard.path().join("folded.parquet");
        write_input(
            &old,
            &[
                OutField {
                    name: "name".to_string(),
                    kind: ColumnKind::Str,
                },
                OutField {
                    name: "start".to_string(),
                    kind: ColumnKind::Int32,
                },
            ],
            vec![
                vec![Cell::Str("a".to_string()), Cell::Int(1)],
                vec![Cell::Str("b".to_string()), Cell::Int(2)],
            ],
        );
        write_input(
            &new,
            &[
                OutField {
                    name: "name".to_string(),
                    kind: ColumnKind::Str,
                },
                OutField {
                    name: "start".to_string(),
                    kind: ColumnKind::Int64,
                },
                OutField {
                    name: "cell".to_string(),
                    kind: ColumnKind::Str,
                },
            ],
            vec![
                vec![
                    Cell::Str("c".to_string()),
                    Cell::Long(3),
                    Cell::Str("node-1".to_string()),
                ],
                vec![Cell::Str("d".to_string()), Cell::Long(4), Cell::Null],
            ],
        );
        fold_files(&[old, new], &out).expect("fold");
        let rows = read_cells(&out);
        assert_eq!(
            rows,
            vec![
                vec![
                    "name=a".to_string(),
                    "start=1".to_string(),
                    "cell=null".to_string()
                ],
                vec![
                    "name=b".to_string(),
                    "start=2".to_string(),
                    "cell=null".to_string()
                ],
                vec![
                    "name=c".to_string(),
                    "start=3".to_string(),
                    "cell=node-1".to_string()
                ],
                vec![
                    "name=d".to_string(),
                    "start=4".to_string(),
                    "cell=null".to_string()
                ],
            ]
        );
    }

    #[test]
    fn a_conflicting_column_type_fails_the_fold_instead_of_guessing() {
        let mut fields = vec![OutField {
            name: "ok".to_string(),
            kind: ColumnKind::Bool,
        }];
        let schema = Type::group_type_builder("x")
            .with_fields(vec![Arc::new(
                Type::primitive_type_builder("ok", PhysicalType::BYTE_ARRAY)
                    .with_repetition(Repetition::OPTIONAL)
                    .build()
                    .expect("field"),
            )])
            .build()
            .expect("schema");
        let error = merge_schema(&mut fields, &schema).expect_err("conflict must fail");
        assert!(error.to_string().contains("conflicting types"), "{error}");
        // INT32/INT64 widen instead.
        let mut fields = vec![OutField {
            name: "ok".to_string(),
            kind: ColumnKind::Int32,
        }];
        let wider = Type::group_type_builder("x")
            .with_fields(vec![Arc::new(
                Type::primitive_type_builder("ok", PhysicalType::INT64)
                    .with_repetition(Repetition::OPTIONAL)
                    .build()
                    .expect("field"),
            )])
            .build()
            .expect("schema");
        merge_schema(&mut fields, &wider).expect("widen");
        assert_eq!(fields[0].name, "ok");
    }
}
